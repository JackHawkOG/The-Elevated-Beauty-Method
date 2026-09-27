import { expect, test, type Page } from "@playwright/test";

type Answers = {
  routineChecks: string[];
  valuesChecks: string[];
  beautyTrend: string;
  masteryGoal: string;
  researchTime: string;
};
type Audit = Answers & { completedAt: string; routineScore: number; valuesScore: number };
type HistoryEntry = Audit & { id: number };

const fixture = (tag: string): Answers => ({
  routineChecks: tag === "third" ? ["skincare-consistency", "product-spending"] : ["skincare-consistency"],
  valuesChecks: tag === "first" ? ["quality-over-price"] : ["quality-over-price", "professional-results"],
  beautyTrend: `${tag} private trend`,
  masteryGoal: `${tag} private goal`,
  researchTime: `${tag} private research`,
});

async function signInAs(page: Page, account: string) {
  await page.goto("/tests/audit-harness.html");
  await page.evaluate(value => localStorage.setItem("audit-test-account", value), account);
  await page.reload();
}

async function submit(page: Page, tag: string) {
  const answers = fixture(tag);
  await page.getByLabel("Skincare consistency").check();
  if (tag === "third") await page.getByLabel("Product spending").check();
  await page.getByLabel("Quality over price").check();
  if (tag !== "first") await page.getByLabel("Professional results").check();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill("member-a@example.invalid");
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
}

const stagedAnswers: Answers = {
  routineChecks: ["skincare-consistency", "product-spending"],
  valuesChecks: ["quality-over-price", "professional-results"],
  beautyTrend: "my private trend",
  masteryGoal: "my private goal",
  researchTime: "my private research time",
};
const originalEmail = "original@example.invalid";
const correctedEmail = "corrected@example.invalid";

async function stageVisitorAnswers(page: Page) {
  await page.goto("/tests/audit-harness.html");
  await page.getByLabel("Skincare consistency").check();
  await page.getByLabel("Product spending").check();
  await page.getByLabel("Quality over price").check();
  await page.getByLabel("Professional results").check();
  await page.locator("#beauty-trend").fill(stagedAnswers.beautyTrend);
  await page.locator("#mastery-goal").fill(stagedAnswers.masteryGoal);
  await page.locator("#research-time").fill(stagedAnswers.researchTime);
  await page.getByLabel("Email address").fill(originalEmail);
  await page.getByRole("button", { name: "Continue to free account" }).click();
  await expect.poll(() => page.evaluate(() =>
    sessionStorage.getItem("tebm:radiant-audit:pending") !== null,
  )).toBe(true);
}

async function stagedInBrowser(page: Page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending") || "null"));
}

test("a corrected verified email requires consent, retains every answer across reload and failed-save retry", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  let failWrites = true;
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.method() === "PUT") {
      const answers = request.postDataJSON() as Answers;
      writes.push({ account: request.headers().authorization, answers });
      if (failWrites) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      return route.fulfill({
        json: {
          audit: { ...answers, routineScore: 2, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" },
          completionKind: "first_time",
        },
      });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : null });
  });

  await stageVisitorAnswers(page);
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  await page.evaluate(() => localStorage.setItem("audit-test-account", "corrected"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await expect(page.getByText(originalEmail, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct email and save my Audit" })).toBeDisabled();
  expect(writes).toHaveLength(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  expect(writes).toHaveLength(0);

  await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
  await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer corrected", answers: stagedAnswers }]);
  expect(await stagedInBrowser(page)).toEqual({ email: correctedEmail, ...stagedAnswers });

  await page.reload();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({ account: "Bearer corrected", answers: stagedAnswers });
  expect(await stagedInBrowser(page)).toEqual({ email: correctedEmail, ...stagedAnswers });

  failWrites = false;
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({ account: "Bearer corrected", answers: stagedAnswers });
  await expect(page.getByText(stagedAnswers.masteryGoal).first()).toBeVisible();
  expect(await stagedInBrowser(page)).toBeNull();
});

test("an unverified account cannot save staged answers, even when its email matches", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    if (route.request().method() === "PUT") writes.push(route.request().postData() ?? "");
    return route.fulfill({ json: null });
  });
  await stageVisitorAnswers(page);
  await page.evaluate(() => {
    localStorage.setItem("audit-test-account", "original");
    localStorage.setItem("audit-test-verified", "false");
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await expect(page.getByText("Verify your account email before saving these answers")).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct email and save my Audit" })).toHaveCount(0);
  await page.reload();
  expect(writes).toHaveLength(0);
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
});

test("an unverified signed-in member cannot save directly from the Audit form", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    if (route.request().method() === "PUT") writes.push(route.request().postData() ?? "");
    return route.fulfill({ json: null });
  });
  await page.goto("/tests/audit-harness.html");
  await page.evaluate(() => {
    localStorage.setItem("audit-test-account", "original");
    localStorage.setItem("audit-test-verified", "false");
  });
  await page.reload();
  await page.getByLabel("Skincare consistency").check();
  await page.getByLabel("Quality over price").check();
  await page.locator("#beauty-trend").fill(stagedAnswers.beautyTrend);
  await page.locator("#mastery-goal").fill(stagedAnswers.masteryGoal);
  await page.locator("#research-time").fill(stagedAnswers.researchTime);
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("alert")).toHaveText("Verify your account email before saving your Audit.");
  expect(writes).toHaveLength(0);
});

test("signing out of the mismatched account preserves the staged answers for the original verified email", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.method() === "PUT") {
      const answers = request.postDataJSON() as Answers;
      writes.push({ account: request.headers().authorization, answers });
      return route.fulfill({
        json: {
          audit: { ...answers, routineScore: 2, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" },
          completionKind: "first_time",
        },
      });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : null });
  });
  await stageVisitorAnswers(page);
  await page.evaluate(() => localStorage.setItem("audit-test-account", "corrected"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with that email" }).click();
  expect(await page.evaluate(() => ({
    account: localStorage.getItem("audit-test-account"),
    redirect: sessionStorage.getItem("audit-test-sign-out-redirect"),
  }))).toEqual({ account: null, redirect: "/sign-in" });
  expect(writes).toHaveLength(0);
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  await page.evaluate(() => localStorage.setItem("audit-test-account", "original"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer original", answers: stagedAnswers }]);
  expect(await stagedInBrowser(page)).toBeNull();
});

test("signed-in member compares both earlier Audits after saving and reload, without another member or answers in tracking", async ({ page }) => {
  const latest = new Map<string, Audit>();
  const history = new Map<string, HistoryEntry[]>();
  const tracking: Array<{ name: string; data?: unknown }> = [];
  let nextId = 1;
  let nextMinute = 0;
  const outsider = fixture("outsider");
  latest.set("member-b", {
    ...outsider,
    completedAt: "2026-09-01T00:00:00.000Z",
    routineScore: 1,
    valuesScore: 2,
  });

  await page.addInitScript(() => {
    (window as unknown as { umami: { track: (name: string, data?: unknown) => void } }).umami = {
      track: (name, data) => {
        (window as unknown as { __auditTracking: Array<{ name: string; data?: unknown }> })
          .__auditTracking.push({ name, data });
      },
    };
    (window as unknown as { __auditTracking: unknown[] }).__auditTracking = [];
  });
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    const account = request.headers().authorization?.replace(/^Bearer /, "");
    if (!account) return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    const isHistory = new URL(request.url()).pathname.endsWith("/history");
    if (request.method() === "GET") {
      return route.fulfill({ json: isHistory ? history.get(account) ?? [] : latest.get(account) ?? null });
    }
    if (request.method() !== "PUT" || isHistory) return route.fulfill({ status: 405 });
    const previous = latest.get(account);
    if (previous) history.set(account, [{ id: nextId++, ...previous }, ...(history.get(account) ?? [])]);
    const answers = request.postDataJSON() as Answers;
    const audit: Audit = {
      ...answers,
      routineScore: answers.routineChecks.length,
      valuesScore: answers.valuesChecks.length,
      completedAt: new Date(Date.UTC(2026, 8, 2, 12, nextMinute++)).toISOString(),
    };
    latest.set(account, audit);
    return route.fulfill({ json: { audit, completionKind: previous ? "retake" : "first_time" } });
  });

  await signInAs(page, "member-b");
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByText(outsider.masteryGoal)).toBeVisible();

  await signInAs(page, "member-a");
  for (const tag of ["first", "second", "third"]) {
    if (tag !== "first") await page.goto("/tests/audit-harness.html");
    await submit(page, tag);
    tracking.push(...await page.evaluate(() =>
      (window as unknown as { __auditTracking: Array<{ name: string; data?: unknown }> }).__auditTracking,
    ));
  }

  const comparison = page.getByRole("region", { name: "How your answers have changed" });
  const earlier = comparison.locator("div").filter({ has: page.getByRole("heading", { name: /^Earlier ·/ }) }).last();
  const latestPanel = comparison.locator("div").filter({ has: page.getByRole("heading", { name: /^Latest ·/ }) }).last();
  await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(2);
  await expect(earlier).toContainText("second private goal");
  await expect(latestPanel).toContainText("third private goal");
  await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index: 1 });
  await expect(earlier).toContainText("first private goal");
  await expect(earlier).not.toContainText("second private goal");
  await expect(latestPanel).toContainText("third private goal");
  await expect(comparison).not.toContainText(outsider.masteryGoal);
  await expect(comparison).not.toContainText(outsider.beautyTrend);
  await expect(comparison).not.toContainText(outsider.researchTime);
  await expect(page.locator("body")).not.toContainText(outsider.masteryGoal);

  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(comparison).toContainText("third private goal");
  await expect(earlier).toContainText("first private goal");
  await page.reload();
  await expect(comparison).toContainText("third private goal");
  await expect(earlier).toContainText("first private goal");
  await comparison.getByRole("combobox", { name: "Compare with" }).selectOption({ index: 0 });
  await expect(earlier).toContainText("second private goal");
  await expect(comparison).not.toContainText(outsider.masteryGoal);
  await expect(page.locator("body")).not.toContainText(outsider.beautyTrend);

  // Capture calls before navigation resets the sink, so a later reload cannot hide a leak.
  expect(tracking).toEqual([
    { name: "radiant_audit_saved", data: { completion_kind: "first_time" } },
    { name: "radiant_audit_saved", data: { completion_kind: "retake" } },
    { name: "radiant_audit_saved", data: { completion_kind: "retake" } },
  ]);
});

test("failed signed-in save preserves answers and checks until a successful retry", async ({ page }) => {
  const answers = fixture("retry");
  const submitted: Answers[] = [];
  const saved: Audit[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __auditTracking: Array<{ name: string; data?: unknown }> }).__auditTracking = [];
    (window as unknown as { umami: { track: (name: string, data?: unknown) => void } }).umami = {
      track: (name, data) => {
        (window as unknown as { __auditTracking: Array<{ name: string; data?: unknown }> })
          .__auditTracking.push({ name, data });
      },
    };
  });
  const tracking = () => page.evaluate(() =>
    (window as unknown as { __auditTracking: Array<{ name: string; data?: unknown }> }).__auditTracking,
  );
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.headers().authorization !== "Bearer member-a") {
      return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    }
    if (request.method() === "GET") {
      return route.fulfill({ json: new URL(request.url()).pathname.endsWith("/history") ? [] : saved.at(-1) ?? null });
    }
    if (request.method() !== "PUT") return route.fulfill({ status: 405 });
    const input = request.postDataJSON() as Answers;
    submitted.push(input);
    if (submitted.length === 1) {
      return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    }
    const audit = {
      ...input,
      routineScore: input.routineChecks.length,
      valuesScore: input.valuesChecks.length,
      completedAt: "2026-09-02T12:00:00.000Z",
    };
    saved.push(audit);
    return route.fulfill({ json: { audit, completionKind: "first_time" } });
  });

  await signInAs(page, "member-a");
  await page.getByLabel("Skincare consistency").check();
  await page.getByLabel("Quality over price").check();
  await page.getByLabel("Professional results").check();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill("member-a@example.invalid");
  await page.getByRole("button", { name: "Save my Audit" }).click();

  await expect(page.getByRole("alert")).toContainText("We couldn't save your Audit");
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toHaveCount(0);
  await expect(page.getByLabel("Skincare consistency")).toBeChecked();
  await expect(page.getByLabel("Quality over price")).toBeChecked();
  await expect(page.getByLabel("Professional results")).toBeChecked();
  await expect(page.locator("#beauty-trend")).toHaveValue(answers.beautyTrend);
  await expect(page.locator("#mastery-goal")).toHaveValue(answers.masteryGoal);
  await expect(page.locator("#research-time")).toHaveValue(answers.researchTime);
  await expect(page.getByLabel("Email address")).toHaveValue("member-a@example.invalid");
  expect(submitted).toEqual([answers]);
  expect(saved).toHaveLength(0);
  expect(await tracking()).toEqual([]);

  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
  expect(submitted).toEqual([answers, answers]);
  expect(saved).toHaveLength(1);
  expect(await tracking()).toEqual([
    { name: "radiant_audit_saved", data: { completion_kind: "first_time" } },
  ]);
});