import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

function requireDevelopment() {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT ||
      !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      !process.env.REPLIT_DEV_DOMAIN?.endsWith(".replit.dev") ||
      !process.env.DATABASE_URL || !process.env.PGHOST || !process.env.PGPORT ||
      !process.env.PGDATABASE || !process.env.PGUSER) {
    throw new Error("The live profile check requires development Clerk, preview, and database.");
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

test("a completed profile save cannot update the next member when its response arrives late", async ({ page }) => {
  test.setTimeout(120_000);
  requireDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = randomUUID().slice(0, 12);
  const a = { email: `profile-a-${marker}+clerk_test@example.com`, name: `Saved A ${marker}`, bio: `Private A ${marker}` };
  const b = { email: `profile-b-${marker}+clerk_test@example.com`, name: `Member B ${marker}` };
  const created: string[] = [];
  try {
    for (const account of [a, b]) {
      const user = await client.users.createUser({
        emailAddress: [account.email],
        firstName: account === a ? "Member A" : b.name,
        skipPasswordRequirement: true,
      });
      created.push(user.id);
    }
    await page.goto("/profile");
    await clerk.signIn({ page, emailAddress: a.email });
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Your Profile" })).toBeVisible();
    await expect(page.locator("main")).toContainText(a.email);

    // Hold the resolved browser fetch, not the request to the API: the server
    // must commit A's change before we change Clerk's active member.
    await page.evaluate(() => {
      const browser = window as typeof window & {
        profileSaveReceived?: boolean;
        releaseProfileSave?: () => void;
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const request = args[0];
        const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
        if (new URL(url, location.href).pathname === "/api/users/me" && args[1]?.method === "PATCH") {
          browser.profileSaveReceived = true;
          await new Promise<void>(resolve => { browser.releaseProfileSave = resolve; });
        }
        return response;
      };
    });
    await page.getByRole("button", { name: "Edit Profile" }).click();
    await page.locator("form input").fill(a.name);
    await page.locator("form textarea").fill(a.bio);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { profileSaveReceived?: boolean }).profileSaveReceived ?? false,
    )).toBe(true);

    const [{ db, usersTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const [saved] = await db.select().from(usersTable).where(eq(usersTable.clerkId, created[0]));
    expect(saved).toMatchObject({ displayName: a.name, bio: a.bio });

    await clerk.signOut({ page });
    await clerk.signIn({ page, emailAddress: b.email });
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(b.email);
    await expect(page.locator("body")).not.toContainText(a.name);
    await expect(page.locator("body")).not.toContainText(a.bio);
    await page.evaluate(({ name, bio, email }) => {
      const browser = window as typeof window & { leakedProfileDetails?: string[]; profileObserver?: MutationObserver };
      browser.leakedProfileDetails = [];
      const check = () => {
        const text = document.body.innerText;
        for (const value of [name, bio, email]) {
          if (text.includes(value) && !browser.leakedProfileDetails?.includes(value)) {
            browser.leakedProfileDetails?.push(value);
          }
        }
      };
      browser.profileObserver = new MutationObserver(check);
      browser.profileObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
    }, a);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your Profile" })).toBeVisible();
    await expect(page.locator("main")).toContainText(b.name);
    await expect(page.locator("main")).toContainText(b.email);
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(b.email);
    // If Clerk navigation replaced the page, it also destroyed the pending
    // callback; require an in-place switch so this exercises the race.
    expect(await page.evaluate(() =>
      (window as typeof window & { profileSaveReceived?: boolean }).profileSaveReceived,
    )).toBe(true);
    await page.evaluate(() => (window as typeof window & { releaseProfileSave?: () => void }).releaseProfileSave?.());
    await page.waitForTimeout(250); // Let the old mutation's callback and any scheduled render finish.
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { leakedProfileDetails?: string[] }).leakedProfileDetails ?? [],
    )).toEqual([]);
    await expect(page.locator("body")).not.toContainText(a.name);
    await expect(page.locator("body")).not.toContainText(a.bio);
    await expect(page.locator("body")).not.toContainText(a.email);
    await expect(page.locator("main")).toContainText(b.name);
    await expect(page.locator('[data-sidebar="footer"]')).toContainText(b.email);
    await page.reload();
    await expect(page.locator("main")).toContainText(b.name);
    await expect(page.locator("body")).not.toContainText(a.name);
    await clerk.signOut({ page });
    await clerk.signIn({ page, emailAddress: a.email });
    await page.goto("/profile");
    await expect(page.locator("main")).toContainText(a.name);
    await expect(page.locator("main")).toContainText(a.bio);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(() => (window as typeof window & { releaseProfileSave?: () => void }).releaseProfileSave?.()).catch(() => {});
    }
    const [{ db, usersTable, pool }, { inArray }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    try {
      if (created.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
    } finally {
      try {
        await Promise.all(created.map(id => client.users.deleteUser(id)));
      } finally {
        await pool.end();
      }
    }
  }
});