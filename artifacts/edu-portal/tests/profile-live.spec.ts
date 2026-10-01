import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import { profileFixturePrivateMetadata } from "./profile-fixtures";

test("two signed-in tabs refresh saved name and bio without replacing an open draft", async ({ page, context }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = randomUUID().slice(0, 12);
  const email = `profile-a-${marker}+clerk_test@example.com`;
  let userId: string | undefined;
  const second = await context.newPage();
  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      firstName: `Profile ${marker}`,
      privateMetadata: profileFixturePrivateMetadata,
      skipPasswordRequirement: true,
    });
    userId = user.id;
    await page.goto("/profile");
    await clerk.signIn({ page, emailAddress: email });
    await page.goto("/profile");
    await expect(page.locator("main")).toContainText(email);
    await second.goto("/profile");
    await expect(second.locator("main")).toContainText(email);

    const savedName = `Saved name ${marker}`;
    const savedBio = `Saved bio ${marker}`;
    await page.getByRole("button", { name: "Edit Profile" }).click();
    await page.locator("form input").fill(savedName);
    await page.locator("form textarea").fill(savedBio);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByRole("button", { name: "Edit Profile" })).toBeVisible();
    // Do not navigate, reload, or focus the receiving tab to trigger this update.
    await expect(second.getByRole("heading", { name: savedName, exact: true })).toBeVisible();
    await expect(second.locator("main")).toContainText(savedBio);

    await second.getByRole("button", { name: "Edit Profile" }).click();
    const draftName = `Unsaved name ${marker}`;
    const draftBio = `Unsaved bio ${marker}`;
    await second.locator("form input").fill(draftName);
    await second.locator("form textarea").fill(draftBio);
    const nextName = `New saved name ${marker}`;
    const nextBio = `New saved bio ${marker}`;
    await page.getByRole("button", { name: "Edit Profile" }).click();
    await page.locator("form input").fill(nextName);
    await page.locator("form textarea").fill(nextBio);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByRole("button", { name: "Edit Profile" })).toBeVisible();
    await expect(second.getByRole("heading", { name: nextName, exact: true })).toBeVisible();
    await expect(second.locator("form input")).toHaveValue(draftName);
    await expect(second.locator("form textarea")).toHaveValue(draftBio);
    // The refresh must not silently rebase the draft and authorize an overwrite.
    await second.getByRole("button", { name: "Save Changes" }).click();
    await expect(second.getByRole("alert")).toContainText(`Saved name: ${nextName}`);
    await expect(second.getByRole("alert")).toContainText(`Saved bio: ${nextBio}`);
    await expect(second.locator("form input")).toHaveValue(draftName);
    await expect(second.locator("form textarea")).toHaveValue(draftBio);
    await second.getByRole("button", { name: "Use latest saved details" }).click();
    await expect(second.locator("form input")).toHaveValue(nextName);
    await expect(second.locator("form textarea")).toHaveValue(nextBio);
    await second.locator("form").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(second.locator("main")).toContainText(nextBio);
    await test.info().attach("refreshed-profile-in-second-tab", {
      body: await second.screenshot(),
      contentType: "image/png",
    });
  } finally {
    // Close both pages before cleanup so pending refreshes cannot recreate rows.
    await second.close();
    await page.close();
    if (userId) {
      const [{ db, usersTable }, { eq }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
      } finally {
        await client.users.deleteUser(userId);
      }
    }
  }
});

test("a completed profile save cannot update the next member when its response arrives late", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
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
        privateMetadata: profileFixturePrivateMetadata,
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
      const browser = window as typeof window & { leakedProfileDetails?: string[]; profileObserver?: MutationObserver };
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
    const [{ db, usersTable }, { inArray }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    try {
      if (created.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, created));
    } finally {
      await Promise.all(created.map(id => client.users.deleteUser(id)));
    }
  }
});

test("an earlier profile response cannot replace a newer save for the same member", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const marker = randomUUID().slice(0, 12);
  const email = `profile-order-${marker}+clerk_test@example.com`;
  const first = { name: `Earlier ${marker}`, bio: `Earlier bio ${marker}` };
  const latest = { name: `Latest ${marker}`, bio: `Latest bio ${marker}` };
  let userId: string | undefined;
  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      firstName: `Member ${marker}`,
      skipPasswordRequirement: true,
    });
    userId = user.id;
    await page.goto("/profile");
    await clerk.signIn({ page, emailAddress: email });
    await page.goto("/profile");
    await expect(page.locator("main")).toContainText(email);

    // Wait until the first response has committed at the API, then hold only
    // its return to React Query. The second save must not be held.
    await page.evaluate(() => {
      const browser = window as typeof window & {
        firstProfileSaveReceived?: boolean;
        releaseFirstProfileSave?: () => void;
      };
      const originalFetch = window.fetch.bind(window);
      let saves = 0;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const request = args[0];
        const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
        if (new URL(url, location.href).pathname === "/api/users/me" && args[1]?.method === "PATCH" && ++saves === 1) {
          browser.firstProfileSaveReceived = true;
          await new Promise<void>(resolve => { browser.releaseFirstProfileSave = resolve; });
        }
        return response;
      };
    });
    await page.getByRole("button", { name: "Edit Profile" }).click();
    await page.locator("form input").fill(first.name);
    await page.locator("form textarea").fill(first.bio);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { firstProfileSaveReceived?: boolean }).firstProfileSaveReceived ?? false,
    )).toBe(true);

    const [{ db, usersTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const [savedFirst] = await db.select().from(usersTable).where(eq(usersTable.clerkId, userId));
    expect(savedFirst).toMatchObject({ displayName: first.name, bio: first.bio });

    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page.locator("main")).toContainText(first.name);
    // A full document navigation would discard the pending callback.
    expect(await page.evaluate(() =>
      (window as typeof window & { firstProfileSaveReceived?: boolean }).firstProfileSaveReceived,
    )).toBe(true);
    await page.getByRole("button", { name: "Edit Profile" }).click();
    await page.locator("form input").fill(latest.name);
    await page.locator("form textarea").fill(latest.bio);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.locator("main")).toContainText(latest.name);
    await expect(page.locator("main")).toContainText(latest.bio);
    const [savedLatest] = await db.select().from(usersTable).where(eq(usersTable.clerkId, userId));
    expect(savedLatest).toMatchObject({ displayName: latest.name, bio: latest.bio });

    await page.evaluate(({ name, bio }) => {
      const browser = window as typeof window & {
        staleProfileDetails?: string[];
        profileObserver?: MutationObserver;
        releaseFirstProfileSave?: () => void;
      };
      browser.staleProfileDetails = [];
      const check = () => {
        for (const value of [name, bio]) {
          if (document.body.innerText.includes(value) && !browser.staleProfileDetails?.includes(value)) {
            browser.staleProfileDetails?.push(value);
          }
        }
      };
      browser.profileObserver = new MutationObserver(check);
      browser.profileObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
      browser.releaseFirstProfileSave?.();
    }, first);
    await page.waitForTimeout(250);
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { staleProfileDetails?: string[] }).staleProfileDetails ?? [],
    )).toEqual([]);
    await expect(page.locator("main")).toContainText(latest.name);
    await expect(page.locator("main")).toContainText(latest.bio);
    await page.reload();
    await expect(page.locator("main")).toContainText(latest.name);
    await expect(page.locator("main")).toContainText(latest.bio);
  } finally {
    if (!page.isClosed()) {
      await page.evaluate(() =>
        (window as typeof window & { releaseFirstProfileSave?: () => void }).releaseFirstProfileSave?.(),
      ).catch(() => {});
    }
    if (userId) {
      const [{ db, usersTable }, { eq }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      try {
        await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
      } finally {
        await client.users.deleteUser(userId);
      }
    }
  }
});
