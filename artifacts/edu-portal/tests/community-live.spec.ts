import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";

function requireDevelopment() {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT ||
      !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      !process.env.REPLIT_DEV_DOMAIN?.endsWith(".replit.dev") ||
      !process.env.DATABASE_URL || !process.env.PGHOST || !process.env.PGPORT ||
      !process.env.PGDATABASE || !process.env.PGUSER) {
    throw new Error("The live community check requires development Clerk, preview, and database.");
  }
  const target = new URL(process.env.DATABASE_URL);
  if (target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE ||
      decodeURIComponent(target.username) !== process.env.PGUSER ||
      [...target.searchParams.keys()].some(key => /^(host|hostaddr|port|dbname|user|service)$/i.test(key))) {
    throw new Error("DATABASE_URL does not target the workspace development database.");
  }
}

const isPost = (url: string, method: string) =>
  method === "POST" && new URL(url).pathname === "/api/announcements";

async function fillDraft(page: Page, title: string, body: string) {
  const dialog = page.getByRole("dialog", { name: "Create Announcement" });
  await dialog.getByPlaceholder("What's new?").fill(title);
  await dialog.getByPlaceholder("Share the details with the community...").fill(body);
  return dialog;
}

test("a lost response retries one signed-in post; editing a failed draft starts a new attempt", async ({ page }) => {
  test.setTimeout(120_000);
  requireDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = randomUUID().slice(0, 12);
  const email = `community-${marker}+clerk_test@example.com`;
  const titles = [`Community retry ${marker}`, `Community changed ${marker}`, `Community changed ${marker} edited`];
  let userId: string | undefined;
  try {
    userId = (await client.users.createUser({
      emailAddress: [email],
      firstName: "Community",
      lastName: "Check",
      skipPasswordRequirement: true,
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
    const retried = page.waitForResponse(response => isPost(response.url(), response.request().method()));
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    const retryResponse = await retried;
    expect(retryResponse.status()).toBe(200);
    expect(retryResponse.request().headers()["idempotency-key"]).toBe(lostKeys[0]);
    await expect(dialog).toHaveCount(0);

    const announcements = page.getByRole("heading", { name: "Announcements", exact: true }).locator("..");
    const activity = page.getByRole("heading", { name: "Recent Activity" }).locator("..");
    await expect(announcements.getByRole("heading", { name: titles[0], exact: true })).toHaveCount(1);
    await expect(activity.getByText(titles[0], { exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "New Post" }).click();
    await fillDraft(page, titles[1], `Original message ${marker}`);
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect.poll(() => lostKeys).toHaveLength(2);
    await expect(dialog.getByRole("button", { name: "Post Announcement" })).toBeEnabled();
    await expect(dialog.getByPlaceholder("What's new?")).toHaveValue(titles[1]);
    await dialog.getByPlaceholder("What's new?").fill(titles[2]);
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
        await db.delete(announcementsTable).where(eq(announcementsTable.actorId, userId));
        await db.delete(activityTable).where(inArray(activityTable.entityTitle, titles));
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