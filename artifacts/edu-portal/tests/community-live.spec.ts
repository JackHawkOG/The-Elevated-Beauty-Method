import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { communityFixtureEmail, communityFixturePrivateMetadata, newCommunityFixtureTag, requireCommunityDevelopment } from "./community-fixtures";

const isPost = (url: string, method: string) =>
  method === "POST" && new URL(url).pathname === "/api/announcements";

async function fillDraft(page: Page, title: string, body: string) {
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("What's new?").fill(title);
  await dialog.getByPlaceholder("Share the details with the community...").fill(body);
  return dialog;
}

test("a lost response survives refresh for one signed-in post; editing starts a new attempt", async ({ page }) => {
  test.setTimeout(120_000);
  requireCommunityDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = newCommunityFixtureTag();
  const email = communityFixtureEmail(marker);
  const titles = [`Community retry ${marker}`, `Community changed ${marker}`, `Community changed ${marker} edited`];
  let userId: string | undefined;
  try {
    userId = (await client.users.createUser({
      emailAddress: [email],
      firstName: "Community",
      lastName: "Check",
      skipPasswordRequirement: true,
      privateMetadata: communityFixturePrivateMetadata,
    })).id;
    await page.goto("/community");
    await clerk.signIn({ page, emailAddress: email });
    await page.goto("/community");
    await expect(page.getByRole("heading", { name: "Community", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New Post" }).click();
    const dialog = await fillDraft(page, titles[0], `Message ${marker}`);

    const lostKeys: string[] = [];
    await page.route("**/api/announcements", async route => {
      const title = route.request().method() === "POST"
        ? (route.request().postDataJSON() as { title?: string }).title : undefined;
      const shouldDrop = title === titles[lostKeys.length] && lostKeys.length < 2;
      if (!isPost(route.request().url(), route.request().method()) ||
          route.request().headers()["x-community-test-commit"] === "1" || !shouldDrop) {
        await route.continue();
        return;
      }
      const key = route.request().headers()["idempotency-key"];
      expect(key).toMatch(/^[0-9a-f-]{36}$/i);
      lostKeys.push(key);
      // Playwright's route.fetch does not preserve this Clerk session. Submit
      // the intercepted form's exact payload/key from the signed-in browser,
      // then drop the form request so its UI sees only a network failure.
      const status = await page.evaluate(async ({ key, body, authorization }) => {
        const response = await fetch("/api/announcements", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "X-Community-Test-Commit": "1",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body,
        });
        return response.status;
      }, { key, body: route.request().postData()!, authorization: route.request().headers()["authorization"] });
      expect(status).toBe(201);
      await route.abort("failed");
    });

    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect(page.getByText("Failed to post", { exact: true }).last()).toBeVisible();
    await expect(dialog.getByPlaceholder("What's new?")).toHaveValue(titles[0]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Community", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review pending post" }).click();
    await expect(dialog.getByRole("heading", { name: "Review pending announcement" })).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText("may already be live");
    await expect(dialog.getByRole("status")).toContainText("without creating a duplicate");
    await expect(dialog.getByPlaceholder("What's new?")).toHaveValue(titles[0]);
    await expect(dialog.getByPlaceholder("Share the details with the community...")).toHaveValue(`Message ${marker}`);
    const retried = page.waitForResponse(response => isPost(response.url(), response.request().method()));
    await dialog.getByRole("button", { name: "Confirm or retry post" }).click();
    const retryResponse = await retried;
    expect(retryResponse.status()).toBe(200);
    expect(retryResponse.request().headers()["idempotency-key"]).toBe(lostKeys[0]);
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:community:pending-announcement"))).toBeNull();

    const announcements = page.getByRole("heading", { name: "Announcements", exact: true }).locator("..");
    const activity = page.getByRole("heading", { name: "Recent Activity" }).locator("..");
    await expect(announcements.getByRole("heading", { name: titles[0], exact: true })).toHaveCount(1);
    await expect(activity.getByText(titles[0], { exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "New Post" }).click();
    await fillDraft(page, titles[1], `Original message ${marker}`);
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect.poll(() => lostKeys).toHaveLength(2);
    await expect(dialog.getByRole("button", { name: "Post Announcement" })).toBeEnabled();
    await page.reload();
    await page.getByRole("button", { name: "Review pending post" }).click();
    await expect(dialog.getByRole("status")).toContainText("edit the title or message first");
    await expect(dialog.getByPlaceholder("What's new?")).toHaveValue(titles[1]);
    await dialog.getByPlaceholder("What's new?").fill(titles[2]);
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Create Announcement" })).toBeVisible();
    const edited = page.waitForResponse(response => isPost(response.url(), response.request().method()));
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    const editedResponse = await edited;
    expect(editedResponse.status()).toBe(201);
    expect(editedResponse.request().headers()["idempotency-key"]).not.toBe(lostKeys[1]);
    await expect(dialog).toHaveCount(0);
    await page.reload();
    for (const title of titles) {
      await expect(announcements.getByRole("heading", { name: title, exact: true })).toHaveCount(1);
      await expect(activity.getByText(title, { exact: true })).toHaveCount(1);
    }
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
    if (userId) {
      const [{ db, announcementsTable, activityTable, usersTable, pool }, { eq, inArray }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        const posts = await db.select({ id: announcementsTable.id }).from(announcementsTable)
          .where(eq(announcementsTable.actorId, userId));
        if (posts.length) await db.delete(activityTable)
          .where(inArray(activityTable.sourceAnnouncementId, posts.map(post => post.id)));
        await db.delete(announcementsTable).where(eq(announcementsTable.actorId, userId));
        await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
      } finally {
        try {
          await client.users.deleteUser(userId);
        } finally {
          await pool.end();
        }
      }
    }
  }
});

test("a pending announcement and its request key cannot cross a same-tab account switch", async ({ page }) => {
  test.setTimeout(120_000);
  requireCommunityDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = newCommunityFixtureTag();
  const accounts = [
    { email: communityFixtureEmail(marker), title: `Private pending ${marker}` },
    { email: communityFixtureEmail(newCommunityFixtureTag()), title: `New member post ${marker}` },
  ];
  const created: string[] = [];
  const keys: string[] = [];
  const storageKey = "tebm:community:pending-announcement";
  try {
    for (const account of accounts) {
      const user = await client.users.createUser({
        emailAddress: [account.email],
        firstName: "Community",
        lastName: "Check",
        skipPasswordRequirement: true,
        privateMetadata: communityFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await page.goto("/community");
    await clerk.signIn({ page, emailAddress: accounts[0].email });
    await page.goto("/community");
    await expect(page.getByRole("heading", { name: "Community", exact: true })).toBeVisible();
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(accounts[0].email);

    // Fail the outgoing request without committing a post, leaving a real
    // pending entry written by the form rather than manufacturing one.
    await page.route("**/api/announcements", async route => {
      if (!isPost(route.request().url(), route.request().method())) {
        await route.continue();
        return;
      }
      keys.push(route.request().headers()["idempotency-key"]);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "New Post" }).click();
    const dialog = await fillDraft(page, accounts[0].title, `Only member A ${marker}`);
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect(page.getByText("Failed to post", { exact: true }).last()).toBeVisible();
    await expect.poll(() => keys).toHaveLength(1);
    const pendingA = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
    expect(JSON.parse(pendingA!)).toMatchObject({
      userId: created[0], title: accounts[0].title, body: `Only member A ${marker}`, requestKey: keys[0],
    });

    await clerk.signOut({ page });
    await clerk.signIn({ page, emailAddress: accounts[1].email });
    await page.goto("/community");
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(accounts[1].email);
    await page.getByRole("button", { name: "New Post" }).click();
    await expect(dialog.getByPlaceholder("What's new?")).toBeEmpty();
    await expect(dialog.getByPlaceholder("Share the details with the community...")).toBeEmpty();

    // Some sign-out paths clear tab storage. Reintroduce A's actual pending
    // entry to verify the author check even when an old entry survives.
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key: storageKey, value: pendingA! });
    await page.reload();
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(accounts[1].email);
    await page.getByRole("button", { name: "New Post" }).click();
    await expect(dialog.getByPlaceholder("What's new?")).toBeEmpty();
    await expect(dialog.getByPlaceholder("Share the details with the community...")).toBeEmpty();
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();

    await fillDraft(page, accounts[1].title, `Only member B ${marker}`);
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect.poll(() => keys).toHaveLength(2);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).not.toBe(keys[0]);
    await expect(page.getByText("Failed to post", { exact: true }).last()).toBeVisible();
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), storageKey))!))
      .toMatchObject({ userId: created[1], title: accounts[1].title, requestKey: keys[1] });
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
    if (created.length) {
      const [{ db, announcementsTable, activityTable, usersTable, pool }, { inArray }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        const posts = await db.select({ id: announcementsTable.id }).from(announcementsTable)
          .where(inArray(announcementsTable.actorId, created));
        if (posts.length) await db.delete(activityTable)
          .where(inArray(activityTable.sourceAnnouncementId, posts.map(post => post.id)));
        await db.delete(announcementsTable).where(inArray(announcementsTable.actorId, created));
        await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
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