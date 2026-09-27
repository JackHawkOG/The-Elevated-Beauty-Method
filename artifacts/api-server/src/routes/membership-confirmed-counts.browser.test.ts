import { randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { db, pool, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { expect, test } from "vitest";
import { progressBrowserEnvironment } from "./member-progress-browser-environment";
import { runWithCleanup } from "./member-progress-browser-cleanup";
import { requireDevelopmentDatabase } from "./test-development-database";

// Run against the development preview, which routes /api through the same
// Clerk middleware and Express mount as the published web application.
test("real Clerk sessions protect paid totals from visitors and members", async () => {
  requireDevelopmentDatabase();
  const { base, chromiumPath } = progressBrowserEnvironment();
  const run = randomUUID();
  const identities: string[] = [];
  const contexts: BrowserContext[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  async function counts(page: Page) {
    return page.evaluate(async () => {
      const response = await fetch("/api/membership/confirmed-counts", { credentials: "same-origin" });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    });
  }

  async function newPage() {
    const context = await browser!.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${base}/sign-in`);
    return page;
  }

  async function signIn(id: string) {
    const page = await newPage();
    await page.waitForFunction(() => Boolean((globalThis as any).Clerk?.loaded));
    const ticket = await clerkClient.signInTokens.createSignInToken({
      userId: id, expiresInSeconds: 120,
    });
    await page.evaluate(async (token) => {
      const clerk = (globalThis as any).Clerk;
      const result = await clerk.client.signIn.create({ strategy: "ticket", ticket: token });
      if (!result.createdSessionId) throw new Error("Clerk did not create a session");
      await clerk.setActive({ session: result.createdSessionId });
    }, ticket.token);
    // The ticket is consumed at sign-in; the user is removed during cleanup.
    return page;
  }

  await runWithCleanup(async () => {
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox"] });

    const visitor = await newPage();
    const anonymous = await counts(visitor);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toHaveProperty("founding");
    expect(anonymous.body).not.toHaveProperty("standard");

    const roles = ["member", "owner", "admin"] as const;
    for (const role of roles) {
      const user = await clerkClient.users.createUser({
        emailAddress: [`membership-counts-${role}-${run}@example.com`],
        firstName: "Membership Counts Check",
        password: `A!${randomUUID()}z9`,
        publicMetadata: { role },
      });
      identities.push(user.id);
    }

    const member = await counts(await signIn(identities[0]));
    expect(member.status).toBe(403);
    expect(member.body).not.toHaveProperty("founding");
    expect(member.body).not.toHaveProperty("standard");

    const owner = await counts(await signIn(identities[1]));
    const admin = await counts(await signIn(identities[2]));
    for (const response of [owner, admin]) {
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(["founding", "standard"]);
      expect(response.body.founding).toEqual(expect.any(Number));
      expect(response.body.standard).toEqual(expect.any(Number));
    }
    expect(admin.body).toEqual(owner.body);
  }, () => [
    ...contexts.map((context, index) => ({
      name: `Close browser context ${index + 1}`, run: () => context.close(),
    })),
    { name: "Close browser", run: async () => { await browser?.close(); } },
    ...(identities.length ? [{
      name: "Delete disposable local members",
      run: () => db.delete(usersTable).where(inArray(usersTable.clerkId, identities)),
    }] : []),
    ...identities.map((id, index) => ({
      name: `Delete disposable Clerk user ${index + 1}`, run: () => clerkClient.users.deleteUser(id),
    })),
    { name: "Close database pool", run: () => pool.end() },
  ]);
}, 120_000);