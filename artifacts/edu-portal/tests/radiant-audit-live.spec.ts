import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { auditFixtureEmail, auditFixturePrivateMetadata, requireAuditDevelopment } from "./radiant-audit-fixtures";

const reflections = (marker: string) => ({
  beautyTrend: `trend ${marker}`,
  masteryGoal: `goal ${marker}`,
  researchTime: `research ${marker}`,
});

async function signIn(page: Page, email: string) {
  await page.goto("/radiant-audit");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/radiant-audit");
  await expect(page.getByRole("button", { name: "Save my Audit" })).toBeVisible();
}

async function signInThroughClerk(page: Page, email: string) {
  await expect(page).toHaveURL(/\/sign-in(?:\/|$)/);
  await page.getByLabel("Email address").fill(email);
  const prepared = page.waitForResponse(response =>
    response.url().includes("/prepare_first_factor") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await prepared;
  await page.getByLabel("Enter verification code").fill("424242");
}

async function cleanUpAccounts(client: ReturnType<typeof createClerkClient>, created: string[]) {
  if (!created.length) return;
  requireAuditDevelopment();
  // The environment guard runs before users are created. Delete only our own
  // disposable identities and their development rows, even on assertion failure.
  const [{ db, radiantAuditDraftsTable, radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditsTable, usersTable }, { eq }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    for (const id of created) {
      await db.delete(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, id));
      await db.delete(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, id));
      await db.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, id));
      await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, id));
      await db.delete(usersTable).where(eq(usersTable.clerkId, id));
    }
  } finally {
    await Promise.all(created.map(id => client.users.deleteUser(id)));
  }
}

async function save(page: Page, email: string, marker: string) {
  const answers = reflections(marker);
  // The accessible checkbox is visually hidden; click its visible label.
  await page.locator('label[for="routine-skincare-consistency"]').click();
  await page.locator('label[for="values-quality-over-price"]').click();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill(email);
  const response = page.waitForResponse(res =>
    res.url().endsWith("/api/users/me/radiant-audit") &&
    res.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save my Audit" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.locator("main")).toContainText(answers.masteryGoal);
}

async function checkComparison(page: Page, own: string[], other: string[]) {
  await page.goto("/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  const comparison = page.getByRole("region", { name: "How your answers have changed" });
  await expect(comparison).toBeVisible();
  for (const marker of own) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(comparison).toContainText(answer);
    }
  }
  for (const marker of other) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(page.locator("body")).not.toContainText(answer);
    }
  }
  await page.reload();
  await expect(comparison).toBeVisible();
  for (const marker of own) {
    await expect(comparison).toContainText(reflections(marker).masteryGoal);
  }
  for (const marker of other) {
    for (const answer of Object.values(reflections(marker))) {
      await expect(page.locator("body")).not.toContainText(answer);
    }
  }
}

test("two real Clerk members keep saved and retaken Audit comparisons private across account switches", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const accounts = [
    { email: auditFixtureEmail("a", tag), markers: [`a-first-${tag}`, `a-retake-${tag}`] },
    { email: auditFixtureEmail("b", tag), markers: [`b-first-${tag}`, `b-retake-${tag}`] },
  ];
  const created: string[] = [];
  try {
    await setupClerkTestingToken({ page });
    for (const account of accounts) {
      const user = await client.users.createUser({
        emailAddress: [account.email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await signIn(page, accounts[0].email);
    await save(page, accounts[0].email, accounts[0].markers[0]);
    await page.goto("/radiant-audit");
    await save(page, accounts[0].email, accounts[0].markers[1]);
    await checkComparison(page, accounts[0].markers, accounts[1].markers);

    await clerk.signOut({ page });
    await signIn(page, accounts[1].email);
    await expect(page.locator("body")).not.toContainText(reflections(accounts[0].markers[1]).masteryGoal);
    await save(page, accounts[1].email, accounts[1].markers[0]);
    await page.goto("/radiant-audit");
    await save(page, accounts[1].email, accounts[1].markers[1]);
    await checkComparison(page, accounts[1].markers, accounts[0].markers);

    await clerk.signOut({ page });
    await signIn(page, accounts[0].email);
    await checkComparison(page, accounts[0].markers, accounts[1].markers);
  } finally {
    await cleanUpAccounts(client, created);
  }
});

test("a delayed Audit response from the previous member never appears after switching accounts", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const a = { email: auditFixtureEmail("late-a", tag), marker: `late-a-${tag}` };
  const b = { email: auditFixtureEmail("late-b", tag) };
  const created: string[] = [];
  let release!: () => void;
  let captured!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { captured = resolve; });
  let held = false;
  let delayed: Promise<void> | undefined;
  const isAuditGet = (route: Route) =>
    route.request().method() === "GET" &&
    new URL(route.request().url()).pathname === "/api/users/me/radiant-audit";

  try {
    for (const account of [a, b]) {
      const user = await client.users.createUser({
        emailAddress: [account.email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await signIn(page, a.email);
    await save(page, a.email, a.marker);
    const aResponse = await page.evaluate(async () => {
      const response = await fetch("/api/users/me/radiant-audit");
      return { status: response.status, body: await response.text() };
    });
    expect(aResponse.status).toBe(200);
    expect(aResponse.body).toContain(reflections(a.marker).masteryGoal);
    // A new page load ensures A's completion query must issue a fresh GET.
    await page.goto("/radiant-audit");
    await page.route("**/api/users/me/radiant-audit", async route => {
      if (!isAuditGet(route) || held) return route.continue();
      held = true;
      delayed = (async () => {
        captured();
        await released;
        // The former query may already be aborted on sign-out, which is safe.
        await route.fulfill({ status: 200, contentType: "application/json", body: aResponse.body }).catch(error => {
          if (!/aborted|closed|cancelled|canceled|intercept/i.test(String(error))) throw error;
        });
      })();
      await delayed;
    });
    await page.goto("/radiant-audit/complete", { waitUntil: "domcontentloaded" });
    await requested;
    expect(held).toBe(true);
    await clerk.signOut({ page });
    await expect(page.locator("body")).not.toContainText(reflections(a.marker).masteryGoal);

    const aAnswers = Object.values(reflections(a.marker));
    await page.evaluate(answers => {
      const windowWithLeak = window as typeof window & { auditLeaks?: string[]; auditObserver?: MutationObserver };
      windowWithLeak.auditLeaks = [];
      const check = () => {
        const text = document.body.innerText;
        for (const answer of answers) {
          if (text.includes(answer) && !windowWithLeak.auditLeaks?.includes(answer)) windowWithLeak.auditLeaks?.push(answer);
        }
      };
      windowWithLeak.auditObserver = new MutationObserver(check);
      windowWithLeak.auditObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      check();
    }, aAnswers);
    await clerk.signIn({ page, emailAddress: b.email });
    release();
    await delayed;
    expect(await page.evaluate(() => (window as typeof window & { auditLeaks?: string[] }).auditLeaks ?? [])).toEqual([]);
    await page.goto("/radiant-audit/complete");
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    for (const answer of aAnswers) await expect(page.locator("body")).not.toContainText(answer);
  } finally {
    release();
    await page.unroute("**/api/users/me/radiant-audit");
    await cleanUpAccounts(client, created);
  }
});

test("staged answers survive real sign-out and sign-in without saving to the wrong verified account", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const wrongEmail = auditFixtureEmail("wrong", tag);
  const stagedEmail = auditFixtureEmail("staged", tag);
  const marker = `recovery-${tag}`;
  const created: string[] = [];
  try {
    await setupClerkTestingToken({ page });
    for (const email of [wrongEmail, stagedEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
      expect(user.primaryEmailAddress?.verification.status).toBe("verified");
    }

    // Start signed out and let the app stage the answers and navigate to auth.
    await page.goto("/radiant-audit");
    await page.locator('label[for="routine-skincare-consistency"]').click();
    await page.locator('label[for="values-quality-over-price"]').click();
    await page.locator("#beauty-trend").fill(reflections(marker).beautyTrend);
    await page.locator("#mastery-goal").fill(reflections(marker).masteryGoal);
    await page.locator("#research-time").fill(reflections(marker).researchTime);
    await page.getByLabel("Email address").fill(stagedEmail);
    await page.getByRole("button", { name: /continue|save my audit/i }).click();
    await expect(page).toHaveURL(/\/sign-up(?:\/|$)/);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).not.toBeNull();

    // Choose an existing account instead of creating another one.
    await page.goto("/sign-in");
    const saves: string[] = [];
    page.on("request", request => {
      if (request.method() === "PUT" && request.url().endsWith("/api/users/me/radiant-audit")) {
        saves.push(request.url());
      }
    });
    await signInThroughClerk(page, wrongEmail);
    await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
    await expect(page.locator("main")).toContainText(stagedEmail);
    await expect(page.locator("main")).toContainText(wrongEmail);
    await expect(page.getByRole("button", { name: "Correct email and save my Audit" })).toBeDisabled();
    expect(saves).toHaveLength(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
    expect(saves).toHaveLength(0);

    // This is the app's actual Clerk sign-out and sign-in redirect, not a
    // programmatic session swap; sessionStorage must survive both navigations.
    await page.getByRole("button", { name: "Use another account" }).click();
    await signInThroughClerk(page, stagedEmail);
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    for (const answer of Object.values(reflections(marker))) {
      await expect(page.locator("main")).toContainText(answer);
    }
    expect(saves).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).toBeNull();

    const [{ db, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const wrong = await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[0]));
    const right = await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[1]));
    expect(wrong).toHaveLength(0);
    expect(right).toHaveLength(1);
    expect(right[0].masteryGoal).toBe(reflections(marker).masteryGoal);
  } finally {
    await cleanUpAccounts(client, created);
  }
});

test("a visitor's staged Audit saves only after the new account verifies its email", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("signup", tag);
  const answers = reflections(`signup-${tag}`);
  const created: string[] = [];
  const auditWrites: Array<{ status?: number; body: string }> = [];
  try {
    await setupClerkTestingToken({ page });
    // Never attach this check to an existing identity, even if the email somehow collides.
    expect((await client.users.getUserList({ emailAddress: [email] })).data).toHaveLength(0);
    page.on("request", request => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/users/me/radiant-audit") {
        auditWrites.push({ body: request.postData() ?? "" });
        void request.response().then(response => {
          const write = auditWrites.find(item => item.body === (request.postData() ?? "") && item.status === undefined);
          if (write) write.status = response?.status();
        });
      }
    });

    await page.goto("/radiant-audit");
    await page.locator('label[for="routine-skincare-consistency"]').click();
    await page.locator('label[for="values-quality-over-price"]').click();
    await page.locator("#beauty-trend").fill(answers.beautyTrend);
    await page.locator("#mastery-goal").fill(answers.masteryGoal);
    await page.locator("#research-time").fill(answers.researchTime);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: /continue|save my audit/i }).click();
    await expect(page).toHaveURL(/\/sign-up(?:\/|$)/);
    const pending = await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"));
    expect(pending).not.toBeNull();
    expect(JSON.parse(pending!)).toMatchObject({
      email, routineChecks: ["skincare-consistency"], valuesChecks: ["quality-over-price"], ...answers,
    });
    expect(auditWrites).toHaveLength(0);

    // Sign up through Clerk's visible form, not an API-created verified account.
    await expect(page.getByLabel("Email address")).toHaveValue(email);
    const password = page.getByLabel("Password", { exact: true });
    if (await password.isVisible()) await password.fill(`Audit!${randomUUID()}9a`);
    const prepared = page.waitForResponse(response =>
      response.url().includes("/prepare_verification") && response.status() === 200,
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await prepared;
    await expect(page.getByLabel("Enter verification code")).toBeVisible();
    expect(auditWrites).toHaveLength(0);

    const [{ db, radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditsTable, usersTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    expect(await db.select().from(usersTable).where(eq(usersTable.email, email))).toHaveLength(0);
    // Clerk may not create a user record until the signup's email code is verified.
    const unverified = (await client.users.getUserList({ emailAddress: [email] })).data;
    if (unverified.length) expect(unverified[0].primaryEmailAddress?.verification.status).not.toBe("verified");
    expect(unverified.length).toBeLessThanOrEqual(1);
    if (unverified.length) {
      created.push(unverified[0].id);
      await client.users.updateUserMetadata(unverified[0].id, { privateMetadata: auditFixturePrivateMetadata });
    }
    expect(created.length ? await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[0])) : []).toHaveLength(0);

    await page.getByLabel("Enter verification code").fill("424242");
    await expect.poll(async () => (await client.users.getUserList({ emailAddress: [email] })).data.length).toBe(1);
    const verified = (await client.users.getUserList({ emailAddress: [email] })).data[0];
    if (!created.length) created.push(verified.id);
    expect(verified.id).toBe(created[0]);
    // Browser signup cannot set private metadata atomically. Mark it as soon as
    // Clerk exposes the verified identity so completed runs are recoverable.
    await client.users.updateUserMetadata(verified.id, { privateMetadata: auditFixturePrivateMetadata });
    const currentRows = () => db.select().from(radiantAuditsTable)
      .where(eq(radiantAuditsTable.clerkId, created[0]));
    await expect(page).toHaveURL(/\/radiant-audit\/complete(?:\/|$)/);
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    for (const answer of Object.values(answers)) await expect(page.locator("main")).toContainText(answer);
    await expect.poll(() => auditWrites.length).toBe(1);
    await expect.poll(() => auditWrites[0].status).toBe(200);
    expect(JSON.parse(auditWrites[0].body)).toMatchObject({
      routineChecks: ["skincare-consistency"], valuesChecks: ["quality-over-price"], ...answers,
    });
    expect((await client.users.getUser(created[0])).primaryEmailAddress?.verification.status).toBe("verified");
    expect((await currentRows()).map(row => [
      row.routineChecks, row.valuesChecks, row.beautyTrend, row.masteryGoal, row.researchTime,
    ])).toEqual([[["skincare-consistency"], ["quality-over-price"], answers.beautyTrend, answers.masteryGoal, answers.researchTime]]);
    expect(await db.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, created[0]))).toHaveLength(0);
    expect(await db.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, created[0]))).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).toBeNull();
    await page.reload();
    await expect(page.locator("main")).toContainText(answers.masteryGoal);
    expect(auditWrites).toHaveLength(1);
  } finally {
    // Signup may create the identity before the verification screen or an assertion fails.
    // Find only the unique email allocated above, then remove its rows and Clerk identity.
    const matches = (await client.users.getUserList({ emailAddress: [email] })).data
      .filter(user => user.emailAddresses.some(address => address.emailAddress.toLowerCase() === email));
    await cleanUpAccounts(client, [...new Set([...created, ...matches.map(user => user.id)])]);
  }
});

test("cancel keeps the current Audit; confirming deletes only current and leaves earlier answers after reload", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-failure", tag);
  let userId: string | undefined;
  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: auditFixturePrivateMetadata,
    });
    userId = user.id;
    await signIn(page, email);
    for (const marker of [`first-${tag}`, `second-${tag}`, `current-${tag}`]) {
      if (!marker.startsWith("first")) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
    await expect(page.locator("main")).toContainText(reflections(`current-${tag}`).masteryGoal);

    let deletes = 0;
    page.on("request", request => {
      if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/users/me/radiant-audit") {
        deletes++;
      }
    });
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    await expect(dialog).toContainText("Earlier Audits will stay in your history, but none will become your current Audit.");
    await expect(dialog.getByRole("button", { name: "Permanently delete current Audit" })).toBeVisible();
    expect(deletes).toBe(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    await expect(page.locator("main")).toContainText(reflections(`current-${tag}`).masteryGoal);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);

    await page.goto("/dashboard");
    const dashboardAudit = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your Radiant Audit" }) });
    await expect(dashboardAudit).toContainText("Your reflection is saved.");
    await expect(dashboardAudit.getByRole("link", { name: "Review your Audit" })).toHaveAttribute("href", "/radiant-audit/complete");

    await page.goto("/radiant-audit/complete");
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    const deleted = page.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/users/me/radiant-audit",
    );

    const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    await confirm.getByRole("button", { name: "Permanently delete current Audit" }).click();
    expect((await deleted).status()).toBe(204);
    expect(deletes).toBe(1);
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit", exact: true })).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(reflections(`current-${tag}`).masteryGoal);
    await expect(comparison).toContainText("you have no current Audit");
    await expect(comparison.getByRole("heading", { name: /^Latest ·/ })).toHaveCount(0);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);

    for (const [index, marker] of [[0, `second-${tag}`], [1, `first-${tag}`]] as const) {
      await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index });
      await expect(comparison).toContainText(reflections(marker).masteryGoal);
      await expect(comparison).toContainText(reflections(marker).beautyTrend);
      await expect(comparison).toContainText(reflections(marker).researchTime);
    }

    await page.reload();
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /^Latest ·/ })).toHaveCount(0);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
    await expect(comparison).toContainText(reflections(`first-${tag}`).masteryGoal);
    await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index: 0 });
    await expect(comparison).toContainText(reflections(`second-${tag}`).masteryGoal);
    await expect(page.locator("main")).not.toContainText(reflections(`current-${tag}`).masteryGoal);

    await page.goto("/dashboard");
    await expect(dashboardAudit).toContainText("Begin with the scorecard and check-in worksheet");
    await expect(dashboardAudit.getByRole("link", { name: "Complete your Audit" })).toHaveAttribute("href", "/radiant-audit");
    await expect(dashboardAudit).not.toContainText("Your reflection is saved.");
    await page.reload();
    await expect(dashboardAudit).toContainText("Begin with the scorecard and check-in worksheet");
    await expect(dashboardAudit.getByRole("link", { name: "Complete your Audit" })).toHaveAttribute("href", "/radiant-audit");
    expect(await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, userId))).toHaveLength(0);
    expect(await db.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, userId))).toHaveLength(2);
  } finally {
    if (userId) await cleanUpAccounts(client, [userId]);
  }
});

test("selected and clear-all earlier Audit confirmations remove only requested history, never current", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-failure", tag);
  const first = `history-first-${tag}`;
  const second = `history-second-${tag}`;
  const current = `history-current-${tag}`;
  const created: string[] = [];
  try {
    await setupClerkTestingToken({ page });
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: auditFixturePrivateMetadata,
    });
    created.push(user.id);
    await signIn(page, email);
    for (const marker of [first, second, current]) {
      if (marker !== first) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const [{ db, radiantAuditsTable, radiantAuditHistoryTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const historyRows = () => db.select().from(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, user.id));
    const currentRows = () => db.select().from(radiantAuditsTable)
      .where(eq(radiantAuditsTable.clerkId, user.id));
    const original = await historyRows();
    expect(original.map(row => row.masteryGoal).sort())
      .toEqual([reflections(first).masteryGoal, reflections(second).masteryGoal].sort());
    expect((await currentRows()).map(row => row.masteryGoal)).toEqual([reflections(current).masteryGoal]);

    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    const selector = comparison.getByRole("combobox", { name: "Compare with" });
    await expect(selector.locator("option")).toHaveCount(2);
    const firstId = original.find(row => row.masteryGoal === reflections(first).masteryGoal)!.id;
    await selector.selectOption(String(firstId));
    await expect(comparison).toContainText(reflections(first).masteryGoal);

    const deletePaths: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "DELETE" && path.startsWith("/api/users/me/radiant-audit")) {
        deletePaths.push(path);
      }
    });

    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const selectedDialog = page.getByRole("alertdialog", { name: "Delete this earlier Audit?" });
    await expect(selectedDialog).toContainText("Your latest Audit will remain saved.");
    await selectedDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(selectedDialog).toHaveCount(0);
    expect(deletePaths).toEqual([]);
    await page.reload();
    await expect(selector).toHaveValue(String(firstId));
    await expect(comparison).toContainText(reflections(first).masteryGoal);
    expect((await historyRows()).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());

    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const selectedResponse = page.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/users/me/radiant-audit/history/${firstId}`,
    );
    await selectedDialog.getByRole("button", { name: "Delete earlier Audit" }).click();
    expect((await selectedResponse).status()).toBe(204);
    await expect(selector.locator("option")).toHaveCount(1);
    await expect(comparison).toContainText(reflections(second).masteryGoal);
    await expect(comparison).not.toContainText(reflections(first).masteryGoal);
    await expect(page.locator("main")).toContainText(reflections(current).masteryGoal);
    await page.reload();
    await expect(selector.locator("option")).toHaveCount(1);
    await expect(comparison).toContainText(reflections(second).masteryGoal);
    await expect(page.locator("body")).not.toContainText(reflections(first).masteryGoal);
    expect((await historyRows()).map(row => row.masteryGoal)).toEqual([reflections(second).masteryGoal]);
    expect((await currentRows()).map(row => row.masteryGoal)).toEqual([reflections(current).masteryGoal]);
    expect(deletePaths).toEqual([`/api/users/me/radiant-audit/history/${firstId}`]);

    await comparison.getByRole("button", { name: "Clear earlier history" }).click();
    const clearDialog = page.getByRole("alertdialog", { name: "Clear all earlier Audits?" });
    await expect(clearDialog).toContainText("Your latest Audit will remain saved.");
    await clearDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(clearDialog).toHaveCount(0);
    await page.reload();
    await expect(selector.locator("option")).toHaveCount(1);
    expect((await historyRows()).map(row => row.masteryGoal)).toEqual([reflections(second).masteryGoal]);
    expect(deletePaths).toEqual([`/api/users/me/radiant-audit/history/${firstId}`]);

    await comparison.getByRole("button", { name: "Clear earlier history" }).click();
    const clearResponse = page.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/users/me/radiant-audit/history",
    );
    await clearDialog.getByRole("button", { name: "Clear earlier history" }).click();
    expect((await clearResponse).status()).toBe(204);
    await expect(comparison).toHaveCount(0);
    await expect(page.locator("main")).toContainText(reflections(current).masteryGoal);
    await page.reload();
    await expect(comparison).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(reflections(second).masteryGoal);
    await expect(page.locator("body")).not.toContainText(reflections(first).masteryGoal);
    await expect(page.locator("main")).toContainText(reflections(current).masteryGoal);
    expect(await historyRows()).toHaveLength(0);
    expect((await currentRows()).map(row => row.masteryGoal)).toEqual([reflections(current).masteryGoal]);
    expect(deletePaths).toEqual([
      `/api/users/me/radiant-audit/history/${firstId}`,
      "/api/users/me/radiant-audit/history",
    ]);
  } finally {
    await cleanUpAccounts(client, created);
  }
});

test("failed current Audit deletion keeps saved answers and history through reload, then retry succeeds", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-failure", tag);
  const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
  let userId: string | undefined;
  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: auditFixturePrivateMetadata,
    });
    userId = user.id;
    await signIn(page, email);
    for (const [index, marker] of markers.entries()) {
      if (index) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const deletePath = "/api/users/me/radiant-audit";
    let failedRequests = 0;
    await page.route("**/api/users/me/radiant-audit", async route => {
      if (route.request().method() !== "DELETE") return route.continue();
      failedRequests++;
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    });
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    const failure = page.waitForResponse(response =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === deletePath,
    );
    await dialog.getByRole("button", { name: "Permanently delete current Audit" }).click();
    expect((await failure).status()).toBe(503);
    expect(failedRequests).toBe(1);
    await expect(dialog.getByRole("alert")).toHaveText("We couldn't delete your current Audit. Please try again.");
    await expect(dialog.getByRole("button", { name: "Permanently delete current Audit" })).toBeEnabled();
    await expect(page.locator("main")).toContainText(reflections(markers[2]).masteryGoal);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    for (const answer of Object.values(reflections(markers[2]))) {
      await expect(page.locator("main")).toContainText(answer);
    }
    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    const choices = comparison.getByRole("combobox", { name: "Compare with" });
    await expect(choices.locator("option")).toHaveCount(2);
    for (const [index, marker] of [markers[1], markers[0]].entries()) {
      await choices.selectOption({ index });
      for (const answer of Object.values(reflections(marker))) {
        await expect(comparison).toContainText(answer);
      }
    }

    await page.goto("/dashboard");
    const dashboardAudit = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your Radiant Audit" }) });
    await expect(dashboardAudit).toContainText("Your reflection is saved.");
    await expect(dashboardAudit.getByRole("link", { name: "Review your Audit" })).toHaveAttribute("href", "/radiant-audit/complete");
    await page.reload();
    await expect(dashboardAudit).toContainText("Your reflection is saved.");

    await page.unroute("**/api/users/me/radiant-audit");
    await page.goto("/radiant-audit/complete");
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const retryDialog = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    const success = page.waitForResponse(response =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === deletePath,
    );
    await retryDialog.getByRole("button", { name: "Permanently delete current Audit" }).click();
    expect((await success).status()).toBe(204);
    await expect(retryDialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(reflections(markers[2]).masteryGoal);
    await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
    await page.goto("/dashboard");
    await expect(dashboardAudit).not.toContainText("Your reflection is saved.");
  } finally {
    if (userId) await cleanUpAccounts(client, [userId]);
  }
});
