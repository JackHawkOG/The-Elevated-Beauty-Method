import { randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { auditFixtureEmail, auditFixturePrivateMetadata, courseSwitchEmail, courseSwitchPrivateMetadata, courseSwitchTitle, newCourseSwitchTag, requireAuditDevelopment } from "./radiant-audit-fixtures";

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

test("a real member's online Audit draft is private and recovers in a fresh browser", async ({ page, browser }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const ownerEmail = auditFixtureEmail("a", tag);
  const otherEmail = auditFixtureEmail("b", tag);
  const answer = `private online draft ${tag}`;
  const created: string[] = [];
  const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];
  const draftPath = "/api/users/me/radiant-audit/draft";

  try {
    for (const email of [ownerEmail, otherEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await setupClerkTestingToken({ page });
    await signIn(page, ownerEmail);
    const baseURL = new URL(page.url()).origin;
    await page.locator("#mastery-goal").fill(answer);
    // Wait for the real debounced browser write, not just local form storage.
    await expect.poll(async () => page.evaluate(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Owner draft GET failed: ${response.status}`);
      return (await response.json() as { masteryGoal?: string } | null)?.masteryGoal;
    }, draftPath)).toBe(answer);

    const otherContext = await browser.newContext({ baseURL });
    contexts.push(otherContext);
    const otherPage = await otherContext.newPage();
    await setupClerkTestingToken({ page: otherPage });
    await signIn(otherPage, otherEmail);
    const otherRead = await otherPage.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, draftPath);
    expect(otherRead).toEqual({ status: 200, body: null });
    await expect(otherPage.locator("main")).not.toContainText(answer);
    // Even if the second member guesses the first member's ID, the server
    // must reject the attempted discard rather than trust the supplied header.
    const stolenDiscard = await otherPage.evaluate(async ({ path, owner }) => {
      const response = await fetch(path, { method: "DELETE", headers: { "x-audit-draft-owner": owner } });
      return response.status;
    }, { path: draftPath, owner: created[0] });
    expect(stolenDiscard).toBe(409);
    const otherDiscard = await otherPage.evaluate(async ({ path, owner }) => {
      const response = await fetch(path, { method: "DELETE", headers: { "x-audit-draft-owner": owner } });
      return response.status;
    }, { path: draftPath, owner: created[1] });
    expect(otherDiscard).toBe(204);

    const recoveredContext = await browser.newContext({ baseURL });
    contexts.push(recoveredContext);
    const recoveredPage = await recoveredContext.newPage();
    await setupClerkTestingToken({ page: recoveredPage });
    await signIn(recoveredPage, ownerEmail);
    await expect(recoveredPage.locator("#mastery-goal")).toHaveValue(answer);
    const recovered = await recoveredPage.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, draftPath);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ masteryGoal: answer });
  } finally {
    try {
      await Promise.all(contexts.map(context => context.close()));
    } finally {
      await cleanUpAccounts(client, created);
    }
  }
});

test("switching real members in one browser never exposes or discards the previous member's unfinished Audit", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const ownerEmail = auditFixtureEmail("a", tag);
  const otherEmail = auditFixtureEmail("b", tag);
  const answer = `private switched draft ${tag}`;
  const draftPath = "/api/users/me/radiant-audit/draft";
  const created: string[] = [];

  try {
    // Install before navigation so every new document watches the form from
    // its first paint, including a value that appears only briefly.
    await page.addInitScript(privateAnswer => {
      const check = () => {
        if (sessionStorage.getItem("audit-switch-watch") !== "1") return;
        if (document.body?.innerText.includes(privateAnswer) ||
            [...document.querySelectorAll("input, textarea")].some(field =>
              (field as HTMLInputElement).value.includes(privateAnswer))) {
          sessionStorage.setItem("audit-switch-leak", "1");
        }
      };
      new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
      const watchValues = () => {
        check();
        requestAnimationFrame(watchValues);
      };
      requestAnimationFrame(watchValues);
    }, answer);
    await setupClerkTestingToken({ page });
    for (const email of [ownerEmail, otherEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await signIn(page, ownerEmail);
    await page.locator("#mastery-goal").fill(answer);
    await expect.poll(async () => page.evaluate(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Owner draft GET failed: ${response.status}`);
      return (await response.json() as { masteryGoal?: string } | null)?.masteryGoal;
    }, draftPath)).toBe(answer);
    const localCopy = await page.evaluate(() => localStorage.getItem("tebm:radiant-audit:signed-in-draft"));
    expect(localCopy).toContain(answer);

    await clerk.signOut({ page });
    await expect(page.locator("body")).not.toContainText(answer);
    // Reintroduce a stale copy after sign-out to model browsers that retain
    // it through an account switch. The server draft remains A's throughout.
    await page.evaluate(raw => {
      localStorage.setItem("tebm:radiant-audit:signed-in-draft", raw);
      sessionStorage.setItem("audit-switch-watch", "1");
    }, localCopy!);
    await signIn(page, otherEmail);
    await expect(page.locator("#mastery-goal")).toHaveValue("");
    await expect(page.locator("main")).not.toContainText(answer);
    expect(await page.evaluate(() => sessionStorage.getItem("audit-switch-leak"))).toBeNull();
    const otherRead = await page.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, draftPath);
    expect(otherRead).toEqual({ status: 200, body: null });
    expect(await page.evaluate(() => localStorage.getItem("tebm:radiant-audit:signed-in-draft") ?? "")).not.toContain(answer);

    // Neither a forged owner header nor the visible discard action may touch A.
    const stolenDiscard = await page.evaluate(async ({ path, owner }) =>
      (await fetch(path, { method: "DELETE", headers: { "x-audit-draft-owner": owner } })).status,
    { path: draftPath, owner: created[0] });
    expect(stolenDiscard).toBe(409);
    const discarded = page.waitForResponse(response =>
      response.url().endsWith(draftPath) && response.request().method() === "DELETE",
    );
    await page.getByTestId("button-discard-audit-draft").click();
    expect((await discarded).status()).toBe(204);
    await expect(page.locator("#mastery-goal")).toHaveValue("");
    await page.reload();
    await expect(page.locator("#mastery-goal")).toHaveValue("");
    expect(await page.evaluate(() => sessionStorage.getItem("audit-switch-leak"))).toBeNull();

    await page.evaluate(() => sessionStorage.removeItem("audit-switch-watch"));
    await clerk.signOut({ page });
    await signIn(page, ownerEmail);
    await expect(page.locator("#mastery-goal")).toHaveValue(answer);
    const recovered = await page.evaluate(async path => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, draftPath);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ masteryGoal: answer });
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      await cleanUpAccounts(client, created);
    }
  }
});

test("an unsynced Audit cannot be silently lost when its member logs out", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const created: string[] = [];
  const email = auditFixtureEmail("a", randomUUID().slice(0, 12));
  const answer = `unsynced draft ${randomUUID()}`;
  const draftPath = "/api/users/me/radiant-audit/draft";
  let blockWrites = true;
  try {
    await setupClerkTestingToken({ page });
    const user = await client.users.createUser({
      emailAddress: [email], skipPasswordRequirement: true, privateMetadata: auditFixturePrivateMetadata,
    });
    created.push(user.id);
    await page.route(`**${draftPath}`, route => {
      if (route.request().method() === "PUT" && blockWrites)
        return route.fulfill({ status: 503, json: { message: "Temporary outage" } });
      return route.continue();
    });
    await signIn(page, email);
    await page.locator("#mastery-goal").fill(answer);
    await expect.poll(() => page.evaluate(() =>
      localStorage.getItem("tebm:radiant-audit:signed-in-draft")?.includes("unsynced draft") ?? false,
    )).toBe(true);
    await page.goto("/dashboard");
    const remoteBefore = await page.evaluate(async path => (await (await fetch(path)).json()) as unknown, draftPath);
    expect(remoteBefore).toBeNull();
    page.once("dialog", async dialog => {
      expect(dialog.message()).toContain("not been saved online");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    await page.goto("/radiant-audit");
    await expect(page.locator("#mastery-goal")).toHaveValue(answer);

    blockWrites = false;
    // Trigger a fresh autosave after the simulated outage recovers.
    await page.locator("#mastery-goal").fill(`${answer} recovered`);
    await expect.poll(async () => page.evaluate(async path =>
      ((await (await fetch(path)).json()) as { masteryGoal?: string } | null)?.masteryGoal,
    draftPath)).toBe(`${answer} recovered`);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Log out" }).click();
    await signIn(page, email);
    await expect(page.locator("#mastery-goal")).toHaveValue(`${answer} recovered`);
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      await cleanUpAccounts(client, created);
    }
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

test("a delayed dashboard membership response cannot show the former member's details after switching accounts", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const aEmail = auditFixtureEmail("dashboard-late-a", tag);
  const bEmail = auditFixtureEmail("dashboard-late-b", tag);
  const created: string[] = [];
  let release!: () => void;
  let captured!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { captured = resolve; });
  let held = false;
  let delayed: Promise<void> | undefined;
  const membershipPanel = page.getByRole("heading", { name: /Your Accelerator is not available right now|The Beauty Mindset Accelerator/ });

  try {
    for (const email of [aEmail, bEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
    }
    await setupClerkTestingToken({ page });
    await signIn(page, aEmail);
    const [{ db, usersTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    await db.update(usersTable).set({ membershipTier: "Elevated" }).where(eq(usersTable.clerkId, created[0]));
    // Capture an authenticated browser response; replaying with route.fetch can lose Clerk auth.
    const aResponse = await page.evaluate(async () => {
      const response = await fetch("/api/users/me");
      return { status: response.status, body: await response.text() };
    });
    expect(aResponse.status).toBe(200);
    expect(JSON.parse(aResponse.body).membershipTier).toBe("Elevated");

    await page.goto("/radiant-audit");
    await page.route("**/api/users/me", async route => {
      if (route.request().method() !== "GET" ||
          new URL(route.request().url()).pathname !== "/api/users/me" || held) {
        return route.continue();
      }
      held = true;
      delayed = (async () => {
        captured();
        await released;
        // Cancellation on account change is a safe outcome too.
        await route.fulfill({ status: 200, contentType: "application/json", body: aResponse.body }).catch(error => {
          if (!/aborted|closed|cancelled|canceled|intercept/i.test(String(error))) throw error;
        });
      })();
      await delayed;
    });
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await requested;
    expect(held).toBe(true);

    await clerk.signOut({ page });
    await expect(membershipPanel).toHaveCount(0);
    // Session storage survives Clerk redirects. Observe each document, so a
    // brief leak during sign-in is not missed by a final-screen assertion.
    const watchDashboard = () => {
      const check = () => {
        if (document.body.innerText.includes("Your Accelerator is not available right now.") ||
            document.querySelector("#accelerator-heading")) {
          sessionStorage.setItem("dashboard-switch-leak", "former member's Elevated panel");
        }
      };
      const observer = new MutationObserver(() => { if (document.body) check(); });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      if (document.body) check();
    };
    await page.addInitScript(watchDashboard);
    await page.evaluate(watchDashboard);
    await clerk.signIn({ page, emailAddress: bEmail });
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    release();
    await delayed;
    await expect(membershipPanel).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("dashboard-switch-leak"))).toBeNull();

    await page.getByRole("link", { name: "Membership and billing" }).click();
    await expect(page).toHaveURL(/\/membership$/);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(membershipPanel).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("dashboard-switch-leak"))).toBeNull();
  } finally {
    release();
    await page.unroute("**/api/users/me");
    await cleanUpAccounts(client, created);
  }
});

test("a delayed enrollment response cannot show the former member's learning progress after switching accounts", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = newCourseSwitchTag();
  const aEmail = courseSwitchEmail("a", tag);
  const bEmail = courseSwitchEmail("b", tag);
  const title = courseSwitchTitle(tag);
  const created: string[] = [];
  let categoryId: number | undefined;
  let courseId: number | undefined;
  let lessonIds: number[] = [];
  let release!: () => void;
  let captured!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { captured = resolve; });
  let held = false;
  let delayed: Promise<void> | undefined;

  const [{ db, categoriesTable, coursesTable, lessonsTable, lessonCompletionsTable, enrollmentsTable }, { and, eq, inArray }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    for (const email of [aEmail, bEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: courseSwitchPrivateMetadata,
      });
      created.push(user.id);
    }
    await setupClerkTestingToken({ page });
    await signIn(page, aEmail);
    // Create a published, test-owned course rather than depending on shared
    // editorial content. The completion makes the leaked progress observable.
    const [category] = await db.insert(categoriesTable).values({ name: title, slug: `course-switch-${tag}` }).returning();
    categoryId = category.id;
    const [course] = await db.insert(coursesTable).values({
      title, description: title, categoryId, instructorName: "Test learner",
      accessTier: "Free", publishedAt: new Date(),
    }).returning();
    courseId = course.id;
    const lessons = await db.insert(lessonsTable).values([0, 1].map(sortOrder => ({
      courseId: course.id, title: `${title} lesson ${sortOrder + 1}`, sortOrder, publishedAt: new Date(),
    }))).returning();
    lessonIds = lessons.map(lesson => lesson.id);
    await db.insert(enrollmentsTable).values({
      userId: created[0], courseId: course.id, completedLessons: 1, lastLessonId: lessons[0].id,
    });
    await db.insert(lessonCompletionsTable).values({ userId: created[0], lessonId: lessons[0].id });

    // Capture an authenticated response first; route.fetch can lose Clerk
    // session authentication when its result is replayed after sign-out.
    const aResponse = await page.evaluate(async () => {
      const response = await fetch("/api/enrollments");
      return { status: response.status, body: await response.text() };
    });
    expect(aResponse.status).toBe(200);
    expect(JSON.parse(aResponse.body)).toContainEqual(expect.objectContaining({
      courseId: course.id, courseTitle: title, completedLessons: 1, totalLessons: 2,
    }));
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator("a", { has: page.getByRole("heading", { name: title }) })).toContainText("1 / 2 Lessons");
    await page.goto("/radiant-audit");

    await page.route("**/api/enrollments", async route => {
      if (route.request().method() !== "GET" ||
          new URL(route.request().url()).pathname !== "/api/enrollments" || held) {
        return route.continue();
      }
      held = true;
      delayed = (async () => {
        captured();
        await released;
        // An aborted former-member request is also a safe outcome.
        await route.fulfill({ status: 200, contentType: "application/json", body: aResponse.body }).catch(error => {
          if (!/aborted|closed|cancelled|canceled|intercept/i.test(String(error))) throw error;
        });
      })();
      await delayed;
    });
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await requested;
    expect(held).toBe(true);
    await clerk.signOut({ page });
    await expect(page.locator("body")).not.toContainText(title);

    // Retain evidence across Clerk redirects and catch even a one-frame render.
    const watchLearning = (privateTitle: string) => {
      const check = () => {
        if (document.body?.innerText.includes(privateTitle)) {
          sessionStorage.setItem("learning-switch-leak", privateTitle);
        }
      };
      new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      check();
    };
    await page.addInitScript(watchLearning, title);
    await page.evaluate(watchLearning, title);
    await clerk.signIn({ page, emailAddress: bEmail });
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No courses yet" })).toBeVisible();
    const bResponse = await page.evaluate(async () => {
      const response = await fetch("/api/enrollments");
      return { status: response.status, body: await response.json() };
    });
    expect(bResponse).toEqual({ status: 200, body: [] });
    release();
    await delayed;
    await expect(page.locator("body")).not.toContainText(title);
    expect(await page.evaluate(() => sessionStorage.getItem("learning-switch-leak"))).toBeNull();

    await page.getByRole("link", { name: "View All" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.locator("body")).not.toContainText(title);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "No courses yet" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(title);
    expect(await page.evaluate(() => sessionStorage.getItem("learning-switch-leak"))).toBeNull();
  } finally {
    release();
    await page.unroute("**/api/enrollments");
    requireAuditDevelopment();
    try {
      if (lessonIds.length && created.length) await db.delete(lessonCompletionsTable).where(
        and(eq(lessonCompletionsTable.userId, created[0]), inArray(lessonCompletionsTable.lessonId, lessonIds)),
      );
      if (courseId !== undefined && created.length) await db.delete(enrollmentsTable).where(
        and(eq(enrollmentsTable.userId, created[0]), eq(enrollmentsTable.courseId, courseId)),
      );
      if (lessonIds.length) await db.delete(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
      if (courseId !== undefined) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
      if (categoryId !== undefined) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    } finally {
      await cleanUpAccounts(client, created);
    }
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

test("an aged post-signup Audit waits for account-specific review and explicit consent with real sign-ins", async ({ page }) => {
  test.setTimeout(180_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const rightEmail = auditFixtureEmail("a", tag);
  const wrongEmail = auditFixtureEmail("b", tag);
  const pendingAnswers = reflections(`aged-${tag}`);
  const rightCurrent = reflections(`right-current-${tag}`);
  const wrongCurrent = reflections(`wrong-current-${tag}`);
  const created: string[] = [];
  const writes: Array<{ body: string; status?: number }> = [];
  const pendingKey = "tebm:radiant-audit:pending";

  try {
    await setupClerkTestingToken({ page });
    for (const email of [rightEmail, wrongEmail]) {
      const user = await client.users.createUser({
        emailAddress: [email],
        skipPasswordRequirement: true,
        privateMetadata: auditFixturePrivateMetadata,
      });
      created.push(user.id);
      expect(user.primaryEmailAddress?.verification.status).toBe("verified");
    }
    await signIn(page, rightEmail);
    await save(page, rightEmail, `right-current-${tag}`);
    await clerk.signOut({ page });
    await signIn(page, wrongEmail);
    await save(page, wrongEmail, `wrong-current-${tag}`);
    await clerk.signOut({ page });

    // Start where a visitor returns after sign-up, but age the staged attempt
    // past the safe retry window before either member authenticates.
    await page.goto("/radiant-audit");
    await page.locator('label[for="routine-skincare-consistency"]').click();
    await page.locator('label[for="values-quality-over-price"]').click();
    await page.locator("#beauty-trend").fill(pendingAnswers.beautyTrend);
    await page.locator("#mastery-goal").fill(pendingAnswers.masteryGoal);
    await page.locator("#research-time").fill(pendingAnswers.researchTime);
    await page.getByLabel("Email address").fill(rightEmail);
    await page.getByRole("button", { name: /continue|save my audit/i }).click();
    await expect(page).toHaveURL(/\/sign-up(?:\/|$)/);
    const oldId = randomUUID();
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await page.evaluate(({ key, oldId, oldTime }) => {
      const pending = JSON.parse(sessionStorage.getItem(key)!);
      sessionStorage.setItem(key, JSON.stringify({ ...pending, submissionId: oldId, stagedAt: oldTime }));
    }, { key: pendingKey, oldId, oldTime });
    page.on("request", request => {
      if (request.method() !== "PUT" || new URL(request.url()).pathname !== "/api/users/me/radiant-audit") return;
      const write = { body: request.postData() ?? "", status: undefined as number | undefined };
      writes.push(write);
      void request.response().then(response => { write.status = response?.status(); });
    });

    await page.goto("/sign-in");
    await signInThroughClerk(page, wrongEmail);
    await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
    await expect(page.locator("main")).toContainText(rightEmail);
    await expect(page.locator("main")).toContainText(wrongEmail);
    expect(writes).toHaveLength(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
    expect(writes).toHaveLength(0);

    // Correcting the email is consent to change the target, not consent to
    // create a retake. The wrong member must still review their own current Audit.
    await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
    await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
    await expect(page.getByRole("heading", { name: "Review your pending Audit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeVisible();
    const wrongRead = await page.evaluate(async () => {
      const response = await fetch("/api/users/me/radiant-audit");
      return { status: response.status, audit: await response.json() };
    });
    expect(wrongRead.status).toBe(200);
    expect(wrongRead.audit.masteryGoal).toBe(wrongCurrent.masteryGoal);
    expect(writes).toHaveLength(0);

    await clerk.signOut({ page });
    // Restore the original staged email as if the visitor chose "Use another
    // account" rather than accepting the corrected target.
    await page.evaluate(({ key, email }) => {
      const pending = JSON.parse(sessionStorage.getItem(key)!);
      sessionStorage.setItem(key, JSON.stringify({ ...pending, email }));
    }, { key: pendingKey, email: rightEmail });
    await page.goto("/sign-in");
    await signInThroughClerk(page, rightEmail);
    await expect(page.getByRole("heading", { name: "Review your pending Audit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeVisible();
    const rightRead = await page.evaluate(async () => {
      const response = await fetch("/api/users/me/radiant-audit");
      return { status: response.status, audit: await response.json() };
    });
    expect(rightRead.status).toBe(200);
    expect(rightRead.audit.masteryGoal).toBe(rightCurrent.masteryGoal);
    expect(rightRead.audit.masteryGoal).not.toBe(wrongRead.audit.masteryGoal);
    await page.reload();
    await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeVisible();
    expect(writes).toHaveLength(0);
    expect(await page.evaluate(key => {
      const { submissionId, stagedAt } = JSON.parse(sessionStorage.getItem(key)!);
      return { submissionId, stagedAt };
    }, pendingKey)).toEqual({ submissionId: oldId, stagedAt: oldTime });

    await page.getByRole("button", { name: "Save as a new retake" }).click();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    await expect(page.locator("main")).toContainText(pendingAnswers.masteryGoal);
    await expect.poll(() => writes[0]?.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body)).toMatchObject({
      routineChecks: ["skincare-consistency"], valuesChecks: ["quality-over-price"], ...pendingAnswers,
    });
    expect(JSON.parse(writes[0].body).submissionId).not.toBe(oldId);
    const [{ db, radiantAuditsTable, radiantAuditHistoryTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    expect((await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[0])))[0].masteryGoal)
      .toBe(pendingAnswers.masteryGoal);
    expect((await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[1])))[0].masteryGoal)
      .toBe(wrongCurrent.masteryGoal);
    expect((await db.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, created[0])))[0].masteryGoal)
      .toBe(rightCurrent.masteryGoal);
    expect(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBeNull();
  } finally {
    await cleanUpAccounts(client, created);
  }
});

test("a wrong sign-in code leaves staged answers untouched until the existing account is verified", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("signin", tag);
  const answers = reflections(`signin-${tag}`);
  const created: string[] = [];
  const auditWrites: string[] = [];
  try {
    await setupClerkTestingToken({ page });
    expect((await client.users.getUserList({ emailAddress: [email] })).data).toHaveLength(0);
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: auditFixturePrivateMetadata,
    });
    created.push(user.id);
    expect(user.primaryEmailAddress?.verification.status).toBe("verified");

    page.on("request", request => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/users/me/radiant-audit") {
        auditWrites.push(request.postData() ?? "");
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

    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(email);
    const prepared = page.waitForResponse(response =>
      response.url().includes("/prepare_first_factor") && response.status() === 200,
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await prepared;
    await expect(page.getByLabel("Enter verification code")).toBeVisible();
    const rejected = page.waitForResponse(response =>
      response.url().includes("/attempt_first_factor") &&
      response.request().method() === "POST" &&
      response.status() >= 400,
    );
    await page.getByLabel("Enter verification code").fill("111111");
    await rejected;
    await expect(page.getByLabel("Enter verification code")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in(?:\/|$)/);
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).toBe(pending);
    expect(auditWrites).toHaveLength(0);

    const [{ db, radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const currentRows = () => db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id));
    const submissions = () => db.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, user.id));
    expect(await currentRows()).toHaveLength(0);
    expect(await submissions()).toHaveLength(0);

    const saved = page.waitForResponse(response =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/users/me/radiant-audit",
    );
    await page.getByLabel("Enter verification code").fill("424242");
    expect((await saved).status()).toBe(200);
    await expect(page).toHaveURL(/\/radiant-audit\/complete(?:\/|$)/);
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    for (const answer of Object.values(answers)) await expect(page.locator("main")).toContainText(answer);
    expect(auditWrites).toHaveLength(1);
    expect(JSON.parse(auditWrites[0])).toMatchObject({
      routineChecks: ["skincare-consistency"], valuesChecks: ["quality-over-price"], ...answers,
    });
    expect((await client.users.getUser(user.id)).primaryEmailAddress?.verification.status).toBe("verified");
    expect((await currentRows()).map(row => [
      row.routineChecks, row.valuesChecks, row.beautyTrend, row.masteryGoal, row.researchTime,
    ])).toEqual([[["skincare-consistency"], ["quality-over-price"], answers.beautyTrend, answers.masteryGoal, answers.researchTime]]);
    expect(await submissions()).toHaveLength(1);
    expect(await db.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, user.id))).toHaveLength(0);
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).toBeNull();
    await page.reload();
    await expect(page.locator("main")).toContainText(answers.masteryGoal);
    expect(auditWrites).toHaveLength(1);
  } finally {
    await page.close();
    await cleanUpAccounts(client, created);
  }
});

test("a wrong signup code and reload keep staged answers until a verified retry saves the Audit", async ({ page }) => {
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

    const rejected = page.waitForResponse(response =>
      response.url().includes("/attempt_verification") &&
      response.request().method() === "POST" &&
      response.status() >= 400,
    );
    await page.getByLabel("Enter verification code").fill("111111");
    await rejected;
    await expect(page.getByLabel("Enter verification code")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up(?:\/|$)/);
    expect(auditWrites).toHaveLength(0);
    expect(await db.select().from(usersTable).where(eq(usersTable.email, email))).toHaveLength(0);
    const afterWrongCode = (await client.users.getUserList({ emailAddress: [email] })).data;
    expect(afterWrongCode.length).toBeLessThanOrEqual(1);
    if (afterWrongCode.length) {
      expect(afterWrongCode[0].primaryEmailAddress?.verification.status).not.toBe("verified");
      if (!created.length) created.push(afterWrongCode[0].id);
      expect(afterWrongCode[0].id).toBe(created[0]);
      await client.users.updateUserMetadata(afterWrongCode[0].id, { privateMetadata: auditFixturePrivateMetadata });
      expect(await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[0]))).toHaveLength(0);
      expect(await db.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, created[0]))).toHaveLength(0);
    }
    const afterWrongPending = await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"));
    expect(afterWrongPending).toBe(pending);

    await page.reload();
    await expect(page).toHaveURL(/\/sign-up(?:\/|$)/);
    await expect(page.getByLabel("Enter verification code")).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("tebm:radiant-audit:pending"))).toBe(pending);
    expect(auditWrites).toHaveLength(0);
    expect(await db.select().from(usersTable).where(eq(usersTable.email, email))).toHaveLength(0);
    if (created.length) {
      expect(await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, created[0]))).toHaveLength(0);
      expect(await db.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, created[0]))).toHaveLength(0);
    }

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
    await page.close();
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

test("a real member cannot delete another Audit after a second session removes the selected one", async ({ page, browser }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("a", tag);
  const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
  const created: string[] = [];
  const contexts: Array<Awaited<ReturnType<typeof browser.newContext>>> = [];

  try {
    const user = await client.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: auditFixturePrivateMetadata,
    });
    created.push(user.id);
    await setupClerkTestingToken({ page });
    await signIn(page, email);
    for (const [index, marker] of markers.entries()) {
      if (index) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const historyRows = () => db.select().from(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, user.id));
    const original = await historyRows();
    expect(original).toHaveLength(2);
    const firstId = original.find(row => row.masteryGoal === reflections(markers[0]).masteryGoal)?.id;
    const remainingId = original.find(row => row.masteryGoal === reflections(markers[1]).masteryGoal)?.id;
    expect(firstId).toBeDefined();
    expect(remainingId).toBeDefined();

    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    contexts.push(otherContext);
    const otherPage = await otherContext.newPage();
    await setupClerkTestingToken({ page: otherPage });
    await signIn(otherPage, email);
    await otherPage.goto("/radiant-audit/complete");
    const otherComparison = otherPage.getByRole("region", { name: "How your answers have changed" });
    await expect(otherComparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);

    // Radix makes the page aria-hidden while the dialog is open; DOM locators
    // let us observe the actual selector updating behind that confirmation.
    const comparison = page.locator('section[aria-labelledby="audit-history-heading"]');
    const selector = page.locator("#earlier-audit");
    await selector.selectOption(String(firstId));
    await expect(comparison).toContainText(reflections(markers[0]).masteryGoal);
    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this earlier Audit?" });
    await expect(dialog).toContainText(`ID ${firstId}`);

    const firstSessionDeletes: string[] = [];
    page.on("request", request => {
      if (request.method() === "DELETE" && new URL(request.url()).pathname.startsWith("/api/users/me/radiant-audit/history")) {
        firstSessionDeletes.push(new URL(request.url()).pathname);
      }
    });
    await otherComparison.getByRole("combobox", { name: "Compare with" }).selectOption(String(firstId));
    await otherComparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const otherDialog = otherPage.getByRole("alertdialog", { name: "Delete this earlier Audit?" });
    await expect(otherDialog).toContainText(`ID ${firstId}`);
    const removed = otherPage.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/users/me/radiant-audit/history/${firstId}`,
    );
    await otherDialog.getByRole("button", { name: "Delete earlier Audit" }).click();
    expect((await removed).status()).toBe(204);
    await expect(otherDialog).toHaveCount(0);
    expect((await historyRows()).map(row => row.id)).toEqual([remainingId]);

    // Keep the first confirmation open while its signed-in query reconnects
    // and fetches the changed history from the real server.
    await page.bringToFront();
    await page.context().setOffline(true);
    const refreshed = page.waitForResponse(response =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/users/me/radiant-audit/history" &&
      response.status() === 200,
    );
    await page.context().setOffline(false);
    expect((await refreshed).status()).toBe(200);
    await expect(selector.locator("option")).toHaveCount(2); // includes the disabled "choose" option
    await expect(selector).toHaveValue("");
    await expect(dialog).toContainText(`ID ${firstId}`);
    await expect(dialog.getByRole("alert")).toContainText("That submission is no longer in your history.");
    await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeDisabled();
    expect(firstSessionDeletes).toEqual([]);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(comparison.getByRole("button", { name: "Delete selected earlier Audit" })).toBeDisabled();
    await page.reload();
    await expect(selector).toHaveValue("");
    await expect(comparison.getByRole("button", { name: "Delete selected earlier Audit" })).toBeDisabled();
    expect(firstSessionDeletes).toEqual([]);
    expect((await historyRows()).map(row => row.id)).toEqual([remainingId]);
    expect((await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id)))
      .map(row => row.masteryGoal)).toEqual([reflections(markers[2]).masteryGoal]);

    await selector.selectOption(String(remainingId));
    await expect(comparison).toContainText(reflections(markers[1]).masteryGoal);
    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    await expect(dialog).toContainText(`ID ${remainingId}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(firstSessionDeletes).toEqual([]);
    expect((await historyRows()).map(row => row.id)).toEqual([remainingId]);
  } finally {
    try {
      await Promise.all(contexts.map(context => context.close()));
    } finally {
      await cleanUpAccounts(client, created);
    }
  }
});

for (const kind of ["selected", "all"] as const) {
  test(`a committed ${kind} earlier Audit deletion with a lost reply confirms the saved history`, async ({ page }) => {
    test.setTimeout(120_000);
    requireAuditDevelopment();
    await clerkSetup();
    const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    const tag = randomUUID().slice(0, 12);
    const email = auditFixtureEmail("delete-lost-reply", tag);
    const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
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
      for (const [index, marker] of markers.entries()) {
        if (index) await page.goto("/radiant-audit");
        await save(page, email, marker);
      }

      const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
        await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
      const historyRows = () => db.select().from(radiantAuditHistoryTable)
        .where(eq(radiantAuditHistoryTable.clerkId, user.id));
      const firstId = (await historyRows()).find(row =>
        row.masteryGoal === reflections(markers[0]).masteryGoal,
      )!.id;
      const historyPath = "/api/users/me/radiant-audit/history";
      const deletePath = kind === "all" ? historyPath : `${historyPath}/${firstId}`;
      const comparison = page.getByRole("region", { name: "How your answers have changed" });
      const choices = comparison.getByRole("combobox", { name: "Compare with" });
      if (kind === "selected") {
        await choices.selectOption(String(firstId));
        await expect(comparison).toContainText(reflections(markers[0]).masteryGoal);
      }

      // Let the authenticated browser commit the real deletion, then lose only
      // the reply seen by the application (route.fetch() can lose Clerk auth).
      await page.evaluate(path => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          if (method === "DELETE" && new URL(url, location.href).pathname === path) {
            throw new TypeError("The history DELETE response was lost");
          }
          return response;
        };
      }, deletePath);
      let deletes = 0;
      let reads = 0;
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path === deletePath && request.method() === "DELETE") deletes++;
        if (path === historyPath && request.method() === "GET") reads++;
      });

      await comparison.getByRole("button", {
        name: kind === "all" ? "Clear earlier history" : "Delete selected earlier Audit",
      }).click();
      const dialog = page.getByRole("alertdialog", {
        name: kind === "all" ? "Clear all earlier Audits?" : "Delete this earlier Audit?",
      });
      const committed = page.waitForResponse(response =>
        response.request().method() === "DELETE" && new URL(response.url()).pathname === deletePath,
      );
      await dialog.getByRole("button", {
        name: kind === "all" ? "Clear earlier history" : "Delete earlier Audit",
      }).click();
      expect((await committed).status()).toBe(204);
      await expect(dialog).toHaveCount(0);
      expect(deletes).toBe(1);
      expect(reads).toBeGreaterThan(0);
      await expect(page.locator("main")).not.toContainText("We couldn't delete your earlier Audit");
      await expect(page.locator("main")).toContainText(reflections(markers[2]).masteryGoal);
      await expect(choices.locator("option")).toHaveCount(kind === "all" ? 0 : 1);
      if (kind === "selected") {
        await expect(comparison).toContainText(reflections(markers[1]).masteryGoal);
        await expect(page.locator("body")).not.toContainText(reflections(markers[0]).masteryGoal);
      } else {
        await expect(comparison).toHaveCount(0);
        await expect(page.locator("body")).not.toContainText(reflections(markers[1]).masteryGoal);
      }

      await page.reload();
      await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
      await expect(page.locator("main")).toContainText(reflections(markers[2]).masteryGoal);
      await expect(choices.locator("option")).toHaveCount(kind === "all" ? 0 : 1);
      expect((await historyRows()).map(row => row.masteryGoal))
        .toEqual(kind === "all" ? [] : [reflections(markers[1]).masteryGoal]);
      expect((await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id)))
        .map(row => row.masteryGoal)).toEqual([reflections(markers[2]).masteryGoal]);
      expect(deletes).toBe(1);
    } finally {
      await cleanUpAccounts(client, created);
    }
  });
}

test("a rejected selected-history deletion leaves both earlier Audits available and can be retried", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-failure", tag);
  const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
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
    for (const [index, marker] of markers.entries()) {
      if (index) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const historyRows = () => db.select().from(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, user.id));
    const currentRows = () => db.select().from(radiantAuditsTable)
      .where(eq(radiantAuditsTable.clerkId, user.id));
    const original = await historyRows();
    const firstId = original.find(row => row.masteryGoal === reflections(markers[0]).masteryGoal)!.id;
    const deletePath = `/api/users/me/radiant-audit/history/${firstId}`;
    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    const choices = comparison.getByRole("combobox", { name: "Compare with" });
    await choices.selectOption(String(firstId));
    let rejected = 0;
    await page.route(`**${deletePath}`, route => {
      if (route.request().method() !== "DELETE") return route.continue();
      rejected++;
      return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    });
    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this earlier Audit?" });
    await dialog.getByRole("button", { name: "Delete earlier Audit" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("We couldn't delete your earlier Audit. Please try again.");
    expect(rejected).toBe(1);
    await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeEnabled();
    await expect(page.locator("main")).not.toContainText("Earlier submission deleted.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(choices).toHaveValue(String(firstId));
    for (const answer of Object.values(reflections(markers[0]))) await expect(comparison).toContainText(answer);
    await choices.selectOption({ index: 0 });
    for (const answer of Object.values(reflections(markers[1]))) await expect(comparison).toContainText(answer);
    for (const answer of Object.values(reflections(markers[2]))) await expect(page.locator("main")).toContainText(answer);
    expect((await historyRows()).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());

    await page.reload();
    await expect(choices.locator("option")).toHaveCount(2);
    for (const marker of markers.slice(0, 2)) {
      await choices.selectOption(String(original.find(row => row.masteryGoal === reflections(marker).masteryGoal)!.id));
      for (const answer of Object.values(reflections(marker))) await expect(comparison).toContainText(answer);
    }
    for (const answer of Object.values(reflections(markers[2]))) await expect(page.locator("main")).toContainText(answer);
    expect((await historyRows()).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());
    expect((await currentRows()).map(row => row.masteryGoal)).toEqual([reflections(markers[2]).masteryGoal]);

    await page.unroute(`**${deletePath}`);
    await choices.selectOption(String(firstId));
    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const retry = page.waitForResponse(response =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === deletePath,
    );
    await dialog.getByRole("button", { name: "Delete earlier Audit" }).click();
    expect((await retry).status()).toBe(204);
    await expect(choices.locator("option")).toHaveCount(1);
    await expect(page.locator("main")).toContainText(reflections(markers[2]).masteryGoal);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await cleanUpAccounts(client, created);
  }
});

test("an uncertain earlier-history deletion with a failed confirmation read asks for refresh without hiding answers", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-failure", tag);
  const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
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
    for (const [index, marker] of markers.entries()) {
      if (index) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const historyRows = () => db.select().from(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, user.id));
    const original = await historyRows();
    const firstId = original.find(row => row.masteryGoal === reflections(markers[0]).masteryGoal)!.id;
    const historyPath = "/api/users/me/radiant-audit/history";
    const deletePath = `${historyPath}/${firstId}`;
    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    const choices = comparison.getByRole("combobox", { name: "Compare with" });
    await choices.selectOption(String(firstId));
    let interrupted = 0;
    let failedReads = 0;
    await page.route("**/api/users/me/radiant-audit/history**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path === deletePath && route.request().method() === "DELETE") {
        interrupted++;
        return route.abort("failed");
      }
      if (path === historyPath && route.request().method() === "GET") {
        failedReads++;
        return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      }
      return route.continue();
    });
    await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this earlier Audit?" });
    await dialog.getByRole("button", { name: "Delete earlier Audit" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "We couldn't confirm whether your earlier Audit was deleted. Please refresh to check before trying again.",
    );
    expect(interrupted).toBe(1);
    expect(failedReads).toBeGreaterThan(0);
    await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeDisabled();
    await expect(page.locator("main")).not.toContainText("Earlier submission deleted.");
    // Radix hides the underlying section from accessibility while the dialog is open.
    const visibleAnswers = page.locator('section[aria-labelledby="audit-history-heading"]');
    for (const answer of Object.values(reflections(markers[0]))) await expect(visibleAnswers).toContainText(answer);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(choices.locator("option")).toHaveCount(2);
    await choices.selectOption({ index: 0 });
    for (const answer of Object.values(reflections(markers[1]))) await expect(comparison).toContainText(answer);
    for (const answer of Object.values(reflections(markers[2]))) await expect(page.locator("main")).toContainText(answer);
    expect((await historyRows()).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());

    await page.unroute("**/api/users/me/radiant-audit/history**");
    await page.reload();
    await expect(choices.locator("option")).toHaveCount(2);
    for (const marker of markers.slice(0, 2)) {
      await choices.selectOption(String(original.find(row => row.masteryGoal === reflections(marker).masteryGoal)!.id));
      for (const answer of Object.values(reflections(marker))) await expect(comparison).toContainText(answer);
    }
    for (const answer of Object.values(reflections(markers[2]))) await expect(page.locator("main")).toContainText(answer);
    expect((await historyRows()).map(row => row.id).sort()).toEqual(original.map(row => row.id).sort());
    expect((await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id)))
      .map(row => row.masteryGoal)).toEqual([reflections(markers[2]).masteryGoal]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
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

test("a committed current Audit deletion with a lost reply reconciles without removing earlier answers", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomUUID().slice(0, 12);
  const email = auditFixtureEmail("delete-lost-reply", tag);
  const markers = [`first-${tag}`, `second-${tag}`, `current-${tag}`];
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
    for (const [index, marker] of markers.entries()) {
      if (index) await page.goto("/radiant-audit");
      await save(page, email, marker);
    }

    const [{ db, radiantAuditHistoryTable, radiantAuditsTable }, { eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const historyRows = () => db.select().from(radiantAuditHistoryTable)
      .where(eq(radiantAuditHistoryTable.clerkId, user.id));
    expect((await historyRows()).map(row => row.masteryGoal).sort())
      .toEqual(markers.slice(0, 2).map(marker => reflections(marker).masteryGoal).sort());

    // Let the signed-in browser make the real DELETE. Only its reply to the app is
    // lost, after the server has committed; route.fetch() can lose Clerk auth.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "DELETE" && new URL(url, location.href).pathname === "/api/users/me/radiant-audit") {
          throw new TypeError("The DELETE response was lost");
        }
        return response;
      };
    });
    const deletePath = "/api/users/me/radiant-audit";
    let deletes = 0;
    let reconciliations = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname !== deletePath) return;
      if (request.method() === "DELETE") deletes++;
      if (request.method() === "GET") reconciliations++;
    });
    await page.getByRole("button", { name: "Delete current Audit" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete your current Audit?" });
    const committed = page.waitForResponse(response =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === deletePath,
    );
    await dialog.getByRole("button", { name: "Permanently delete current Audit" }).click();
    expect((await committed).status()).toBe(204);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    expect(deletes).toBe(1);
    expect(reconciliations).toBeGreaterThan(0);
    await expect(page.locator("main")).not.toContainText("We couldn't delete your current Audit");
    await expect(page.locator("main")).not.toContainText(reflections(markers[2]).masteryGoal);
    expect(await db.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id))).toHaveLength(0);

    const comparison = page.getByRole("region", { name: "How your answers have changed" });
    const choices = comparison.getByRole("combobox", { name: "Compare with" });
    await expect(comparison).toContainText("you have no current Audit");
    await expect(choices.locator("option")).toHaveCount(2);
    for (const [index, marker] of [markers[1], markers[0]].entries()) {
      await choices.selectOption({ index });
      for (const answer of Object.values(reflections(marker))) {
        await expect(comparison).toContainText(answer);
      }
    }
    await page.reload();
    await expect(page.getByRole("heading", { name: "Start your Radiant Audit" })).toBeVisible();
    await expect(choices.locator("option")).toHaveCount(2);
    await expect(page.locator("main")).not.toContainText(reflections(markers[2]).masteryGoal);
    expect((await historyRows()).map(row => row.masteryGoal).sort())
      .toEqual(markers.slice(0, 2).map(marker => reflections(marker).masteryGoal).sort());

    await page.goto("/dashboard");
    const dashboardAudit = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your Radiant Audit" }) });
    await expect(dashboardAudit).toContainText("Begin with the scorecard and check-in worksheet");
    await expect(dashboardAudit.getByRole("link", { name: "Complete your Audit" })).toHaveAttribute("href", "/radiant-audit");
    await page.goto("/radiant-audit");
    await expect(page.getByRole("button", { name: "Save my Audit" })).toBeVisible();
  } finally {
    await cleanUpAccounts(client, created);
  }
});
