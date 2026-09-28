import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { newStoryFixtureTag, requireStoryDevelopment, storyFixtureEmail, storyFixturePrivateMetadata } from "./member-stories-fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/dashboard");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
}

test("real owner publication and withdrawal update an already-open signed-out landing page", async ({ browser, page }) => {
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

    // This separate visitor stays on the landing page while the owner uses their own tab.
    visitorContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const visitor = await visitorContext.newPage();
    await visitor.goto("/");
    await expect(visitor.getByRole("link", { name: "Sign In", exact: true })).toBeVisible();
    const publicStory = visitor.locator("figure").filter({ hasText: quote });
    await expect(publicStory).toContainText(attribution);
    await expect(visitor.locator("body")).not.toContainText(permission);

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
      const [{ db, memberStoriesTable, usersTable, pool }, { eq, inArray, and }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        if (created[0]) await db.delete(memberStoriesTable).where(and(
          eq(memberStoriesTable.quote, quote), eq(memberStoriesTable.permissionRecordedBy, created[0]),
        ));
        if (created.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
      } finally {
        try {
          await Promise.all(created.map(id => client.users.deleteUser(id)));
        } finally {
          await pool.end();
        }
      }
    }
  }
});
