import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { newStoryFixtureTag, requireStoryDevelopment, storyFixtureEmail, storyFixturePrivateMetadata } from "./member-stories-fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/dashboard");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
}

test("real owner publication and withdrawal update an already-open signed-out landing page", async ({ browser, page }) => {
  test.setTimeout(150_000);
  requireStoryDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = newStoryFixtureTag();
  const ownerEmail = storyFixtureEmail("owner", marker);
  const memberEmail = storyFixtureEmail("member", marker);
  const quote = `Approved browser check ${marker}`;
  const attribution = `Story check ${marker}`;
  const permission = `Disposable test approval for exact quote and attribution ${marker}`;
  const created: string[] = [];
  let visitorContext: BrowserContext | undefined;
  try {
    const owner = await client.users.createUser({
      emailAddress: [ownerEmail], firstName: "Story", lastName: "Owner",
      publicMetadata: { role: "owner" }, privateMetadata: storyFixturePrivateMetadata,
      skipPasswordRequirement: true,
    });
    created.push(owner.id);
    const member = await client.users.createUser({
      emailAddress: [memberEmail], firstName: "Story", lastName: "Member",
      privateMetadata: storyFixturePrivateMetadata, skipPasswordRequirement: true,
    });
    created.push(member.id);

    await signIn(page, ownerEmail);
    // Establish the signed-out visitor's initial empty result before publishing.
    // Waiting for the feed response prevents a slow first load from masquerading as a poll.
    visitorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const visitor = await visitorContext.newPage();
    const initialFeed = visitor.waitForResponse(response =>
      /\/api\/member-stories(?:\?.*)?$/.test(response.url()) && response.status() === 200,
    );
    await visitor.goto("/");
    await initialFeed;
    await expect(visitor.getByRole("link", { name: "Sign In", exact: true })).toBeVisible();
    const publicStory = visitor.locator("figure").filter({ hasText: quote });
    await expect(publicStory).toHaveCount(0);
    await expect(visitor.locator("body")).not.toContainText(attribution);

    await expect(page.getByRole("link", { name: "Member stories" })).toBeVisible();
    await page.getByRole("link", { name: "Member stories" }).click();
    await expect(page.getByRole("heading", { name: "Publish an approved story" })).toBeVisible();
    await page.getByLabel("Approved quote").fill(quote);
    await page.getByLabel("Approved public attribution").fill(attribution);
    await page.getByLabel(/Permission record/).fill(permission);
    await page.getByLabel(/I confirm the member explicitly gave permission/).check();
    await page.getByRole("button", { name: "Publish story" }).click();
    await expect(page.getByRole("status")).toHaveText("Story published.");
    const story = page.locator("article").filter({ hasText: quote });
    await expect(story).toContainText(permission);
    await expect(story).toContainText(attribution);
    await expect(story).toContainText("Published");

    // The visitor must receive both fields via polling, without navigating or reloading.
    await expect(publicStory).toContainText(quote, { timeout: 12_000 });
    await expect(publicStory).toContainText(attribution);
    await expect(visitor).toHaveURL("/");
    await expect(visitor.locator("body")).not.toContainText(permission);

    // An outage after the quote loaded must not leave an unverified quote visible.
    let failedRefreshes = 0;
    const storyFeed = /\/api\/member-stories(?:\?.*)?$/;
    await visitor.route(storyFeed, async route => {
      failedRefreshes++;
      await route.fulfill({ status: 503, body: "Story feed unavailable" });
    });
    await expect(publicStory).toHaveCount(0, { timeout: 22_000 });
    expect(failedRefreshes).toBeGreaterThan(0);
    await expect(visitor.locator("body")).not.toContainText(attribution);
    await visitor.unroute(storyFeed);
    await expect(publicStory).toContainText(attribution, { timeout: 15_000 });

    await clerk.signOut({ page });
    await signIn(page, memberEmail);
    await expect(page.getByRole("link", { name: "Member stories" })).toHaveCount(0);
    await page.goto("/member-stories");
    await expect(page.getByRole("heading", { name: "Publish an approved story" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw story" })).toHaveCount(0);
    const memberAccess = await page.evaluate(async () => {
      const response = await fetch("/api/member-stories/manage");
      return response.status;
    });
    expect(memberAccess).toBe(403);

    await clerk.signOut({ page });
    await signIn(page, ownerEmail);
    await page.goto("/member-stories");
    const managedStory = page.locator("article").filter({ hasText: quote });
    await expect(managedStory).toContainText(permission);
    await managedStory.getByRole("button", { name: "Withdraw story" }).click();
    await managedStory.getByRole("button", { name: "Confirm withdrawal" }).click();
    await expect(page.getByRole("status")).toHaveText("Story withdrawn from the public landing page.");
    await expect(managedStory).toContainText("Withdrawn");

    // Do not navigate or reload the visitor: the published-story poll must remove both fields.
    await expect(publicStory).toHaveCount(0, { timeout: 12_000 });
    await expect(visitor.locator("body")).not.toContainText(attribution);

    await clerk.signOut({ page });
    await page.goto("/");
    await expect(page.locator("figure").filter({ hasText: quote })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(attribution);
  } finally {
    // Remove only this run's disposable story and accounts, including on assertion failure.
    try {
      await visitorContext?.close();
    } finally {
      const [{ db, memberStoriesTable, usersTable }, { eq, inArray, and }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        if (created[0]) await db.delete(memberStoriesTable).where(and(
          eq(memberStoriesTable.quote, quote), eq(memberStoriesTable.permissionRecordedBy, created[0]),
        ));
        if (created.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
      } finally {
        await Promise.all(created.map(id => client.users.deleteUser(id)));
      }
    }
  }
});

test("an open owner dashboard notices a member's removal request without exposing private details", async ({ browser, page }) => {
  test.setTimeout(120_000);
  requireStoryDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = newStoryFixtureTag();
  const ownerEmail = storyFixtureEmail("owner", marker);
  const memberEmail = storyFixtureEmail("member", marker);
  const quote = `Approved browser check ${marker}`;
  const attribution = `Story check ${marker}`;
  const permission = `Disposable test approval for exact quote and attribution ${marker}`;
  const note = `Please hide my story ${marker}`;
  const created: string[] = [];
  let memberContext: BrowserContext | undefined;
  let visitorContext: BrowserContext | undefined;
  try {
    const owner = await client.users.createUser({
      emailAddress: [ownerEmail], firstName: "Story", lastName: "Owner",
      publicMetadata: { role: "owner" }, privateMetadata: storyFixturePrivateMetadata,
      skipPasswordRequirement: true,
    });
    created.push(owner.id);
    const member = await client.users.createUser({
      emailAddress: [memberEmail], firstName: "Story", lastName: "Member",
      privateMetadata: storyFixturePrivateMetadata, skipPasswordRequirement: true,
    });
    created.push(member.id);

    await setupClerkTestingToken({ page });
    await signIn(page, ownerEmail);
    await page.goto("/member-stories");
    await page.getByLabel("Approved quote").fill(quote);
    await page.getByLabel("Approved public attribution").fill(attribution);
    await page.getByLabel(/Permission record/).fill(permission);
    await page.getByLabel(/I confirm the member explicitly gave permission/).check();
    await page.getByRole("button", { name: "Publish story" }).click();
    const published = page.locator("article").filter({ hasText: quote });
    await expect(published).toContainText(permission);
    const id = Number((await published.getAttribute("id"))?.replace("story-", ""));
    expect(Number.isSafeInteger(id)).toBe(true);

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    const ownerAlert = page.getByRole("status").getByRole("link", { name: new RegExp(`story #${id}`) });
    await expect(ownerAlert).toHaveCount(0);

    const origin = new URL(page.url()).origin;
    visitorContext = await browser.newContext({ baseURL: origin });
    const visitor = await visitorContext.newPage();
    await visitor.goto("/");
    const publicStory = visitor.locator("figure").filter({ hasText: quote });
    await expect(publicStory).toContainText(attribution);
    await expect(visitor.locator("body")).not.toContainText(permission);

    memberContext = await browser.newContext({ baseURL: origin });
    const memberPage = await memberContext.newPage();
    await setupClerkTestingToken({ page: memberPage });
    await signIn(memberPage, memberEmail);
    await expect(memberPage.getByRole("link", { name: "Member stories" })).toHaveCount(0);
    await memberPage.goto("/stories");
    const memberStory = memberPage.locator("article").filter({ hasText: quote });
    await expect(memberStory).toBeVisible();
    await expect(memberPage.locator("body")).not.toContainText(permission);
    await memberStory.getByRole("button", { name: "Is this your story? Request removal" }).click();
    await memberStory.getByLabel(/How is this story connected to you/).fill(note);
    await memberStory.getByRole("button", { name: "Request removal now" }).click();
    await expect(memberPage.getByText("Your removal request was received. The owner can now review it privately.", { exact: true })).toBeVisible();
    await expect(memberPage.locator("article").filter({ hasText: quote })).toHaveCount(0);
    await expect(memberPage.locator("body")).not.toContainText(note);
    await expect(memberPage.locator("body")).not.toContainText(permission);
    await expect(memberPage.locator("body")).not.toContainText("Removal requests received");
    const privateResponses = await memberPage.evaluate(async () => {
      const [alerts, manage] = await Promise.all([
        fetch("/api/member-stories/removal-alerts"),
        fetch("/api/member-stories/manage"),
      ]);
      return [alerts.status, manage.status];
    });
    expect(privateResponses).toEqual([403, 403]);

    // The owner page has not been reloaded, focused, or navigated since the request.
    await expect(ownerAlert).toBeVisible({ timeout: 45_000 });
    await expect(page.getByLabel(/\d+ outstanding story removal requests/)).toBeVisible();
    await expect(ownerAlert).toHaveAttribute("href", `/member-stories#story-${id}`);
    await ownerAlert.click();
    await expect(page).toHaveURL(new RegExp(`/member-stories#story-${id}$`));
    await expect(page.locator(`#story-${id}`)).toContainText(note);
    await expect(page.locator(`#story-${id}`)).toContainText(permission);
    await expect(page.locator(`#story-${id}`)).toContainText(memberEmail);
    await expect(page.locator(`#story-${id}`)).toContainText("Withdrawn");

    // The separate public tab must lose the story without a reload.
    await expect(publicStory).toHaveCount(0, { timeout: 12_000 });
    await expect(visitor.locator("body")).not.toContainText(attribution);
    await visitor.reload();
    await expect(visitor.locator("body")).not.toContainText(quote);
    await expect(visitor.locator("body")).not.toContainText(note);
    await expect(visitor.locator("body")).not.toContainText(permission);
  } finally {
    // Close active pages before deleting rows: in-flight requests must not recreate fixture state.
    await Promise.allSettled([memberContext?.close(), visitorContext?.close(), page.close()]);
    const [{ db, memberStoriesTable, usersTable }, { eq, inArray, and }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    if (created[0]) await db.delete(memberStoriesTable).where(and(
      eq(memberStoriesTable.quote, quote), eq(memberStoriesTable.permissionRecordedBy, created[0]),
    ));
    if (created.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
    await Promise.all(created.map(id => client.users.deleteUser(id)));
  }
});
