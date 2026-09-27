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
const signedInDraftKey = "tebm:radiant-audit:signed-in-draft";

test.beforeEach(async ({ page }) => {
  // Default draft API for tests concerned with other Audit flows.
  await page.route("**/api/users/me/radiant-audit/draft", route => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: null });
    if (method === "DELETE") return route.fulfill({ status: 204 });
    return route.fulfill({ json: route.request().postDataJSON() });
  });
});

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
  return page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending") || "null");
    if (!value) return null;
    const { submissionId: _submissionId, ...answers } = value;
    return answers;
  });
}

test("a corrected verified email requires consent, retains every answer across reload and failed-save retry", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers; submissionId: string }> = [];
  let failWrites = true;
  let savedAudit: Audit | null = null;
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.method() === "PUT") {
      const { submissionId, ...answers } = request.postDataJSON() as Answers & { submissionId: string };
      writes.push({ account: request.headers().authorization, answers, submissionId });
      if (failWrites) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      savedAudit = { ...answers, routineScore: 2, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" };
      return route.fulfill({
        json: {
          audit: savedAudit,
          completionKind: "first_time",
        },
      });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : savedAudit });
  });

  await stageVisitorAnswers(page);
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  const stagedId = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!)?.submissionId as string,
  );
  expect(stagedId).toBeTruthy();
  await page.evaluate(() => localStorage.setItem("audit-test-account", "corrected"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await expect(page.getByText(originalEmail, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct email and save my Audit" })).toBeDisabled();
  expect(writes).toHaveLength(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  expect(await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!)?.submissionId,
  )).toBe(stagedId);
  expect(writes).toHaveLength(0);

  await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
  await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer corrected", answers: stagedAnswers, submissionId: stagedId }]);
  expect(await stagedInBrowser(page)).toEqual({ email: correctedEmail, ...stagedAnswers });
  expect(await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!)?.submissionId,
  )).toBe(stagedId);

  await page.reload();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({ account: "Bearer corrected", answers: stagedAnswers, submissionId: stagedId });
  expect(await stagedInBrowser(page)).toEqual({ email: correctedEmail, ...stagedAnswers });

  failWrites = false;
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({ account: "Bearer corrected", answers: stagedAnswers, submissionId: stagedId });
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
  await expect(page.getByText(/Verify your primary email in your account profile/)).toBeVisible();
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

test("partial answers staged for email verification return to the form and never auto-save", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    if (route.request().method() === "PUT") {
      const request = route.request();
      const { submissionId: _submissionId, ...answers } = request.postDataJSON() as Answers & { submissionId: string };
      writes.push({ account: request.headers().authorization, answers });
      return route.fulfill({ json: {
        audit: { ...answers, routineScore: 1, valuesScore: 0, completedAt: "2026-09-02T12:00:00.000Z" },
        completionKind: "first_time",
      } });
    }
    return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
  });

  await signInAs(page, "original");
  await page.evaluate(() => localStorage.setItem("audit-test-verified", "false"));
  await page.reload();
  await page.getByLabel("Skincare consistency").locator("..").click();
  await page.locator("#beauty-trend").fill("unfinished verification trend");
  await page.getByRole("button", { name: "Verify my email" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("audit-test-profile-opened"))).toBe("true");
  expect(await stagedInBrowser(page)).toMatchObject({
    email: originalEmail,
    routineChecks: ["skincare-consistency"],
    beautyTrend: "unfinished verification trend",
    masteryGoal: "",
    researchTime: "",
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(writes).toHaveLength(0);

  await page.evaluate(() => localStorage.setItem("audit-test-verified", "true"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Finish your Radiant Audit" })).toBeVisible();
  await page.reload();
  expect(writes).toHaveLength(0);
  await page.getByRole("link", { name: "Continue my Audit" }).click();
  await expect(page.getByLabel("Skincare consistency")).toBeChecked();
  await expect(page.locator("#beauty-trend")).toHaveValue("unfinished verification trend");
  await expect(page.locator("#mastery-goal")).toHaveValue("");
  await expect(page.locator("#research-time")).toHaveValue("");
  await page.getByRole("button", { name: "Save my Audit" }).click();
  expect(writes).toHaveLength(0);
  await page.locator("#mastery-goal").fill("completed verification goal");
  await page.locator("#research-time").fill("one hour");
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer original", answers: {
    routineChecks: ["skincare-consistency"],
    valuesChecks: [],
    beautyTrend: "unfinished verification trend",
    masteryGoal: "completed verification goal",
    researchTime: "one hour",
  } }]);
});

test("partial answers staged before an account switch need consent, completion and a verified primary email", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    if (route.request().method() === "PUT") writes.push(route.request().postData() ?? "");
    return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
  });

  await signInAs(page, "original");
  await page.evaluate(() => localStorage.setItem("audit-test-verified", "false"));
  await page.reload();
  await page.getByLabel("Quality over price").locator("..").click();
  await page.locator("#mastery-goal").fill("unfinished switch goal");
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await stagedInBrowser(page)).toMatchObject({
    email: originalEmail,
    routineChecks: [],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "",
    masteryGoal: "unfinished switch goal",
    researchTime: "",
  });
  expect(await page.evaluate(() => localStorage.getItem("audit-test-account"))).toBeNull();

  await page.evaluate(() => {
    localStorage.setItem("audit-test-account", "corrected");
    localStorage.setItem("audit-test-verified", "true");
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
  await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Finish your Radiant Audit" })).toBeVisible();
  expect(await stagedInBrowser(page)).toMatchObject({ email: correctedEmail, masteryGoal: "unfinished switch goal" });
  await page.reload();
  expect(writes).toHaveLength(0);
  await page.getByRole("link", { name: "Continue my Audit" }).click();
  await expect(page.getByLabel("Quality over price")).toBeChecked();
  await expect(page.locator("#mastery-goal")).toHaveValue("unfinished switch goal");
  await expect(page.locator("#beauty-trend")).toHaveValue("");
  await expect(page.locator("#research-time")).toHaveValue("");
  await expect(page.getByLabel("Email address")).toHaveValue(correctedEmail);
  await page.getByRole("button", { name: "Save my Audit" }).click();
  expect(writes).toHaveLength(0);
});

test("signing out of the mismatched account preserves the staged answers for the original verified email", async ({ page }) => {
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.method() === "PUT") {
      const { submissionId: _submissionId, ...answers } = request.postDataJSON() as Answers & { submissionId: string };
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
  await page.getByRole("button", { name: "Use another account" }).click();
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
    const input = request.postDataJSON() as Answers;
    const audit: Audit = {
      ...input,
      routineScore: input.routineChecks.length,
      valuesScore: input.valuesChecks.length,
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
  const submissionIds: string[] = [];
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
    const { submissionId, ...input } = request.postDataJSON() as Answers & { submissionId: string };
    submissionIds.push(submissionId);
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
  await page.reload();
  await expect(page.getByLabel("Skincare consistency")).toBeChecked();
  await expect(page.getByLabel("Quality over price")).toBeChecked();
  await expect(page.getByLabel("Professional results")).toBeChecked();
  await expect(page.locator("#beauty-trend")).toHaveValue(answers.beautyTrend);
  await expect(page.locator("#mastery-goal")).toHaveValue(answers.masteryGoal);
  await expect(page.locator("#research-time")).toHaveValue(answers.researchTime);
  await expect(page.getByLabel("Email address")).toHaveValue("member-a@example.invalid");
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

  await page.reload();
  await expect(page.getByLabel("Skincare consistency")).toBeChecked();
  await expect(page.getByLabel("Quality over price")).toBeChecked();
  await expect(page.getByLabel("Professional results")).toBeChecked();
  await expect(page.locator("#beauty-trend")).toHaveValue(answers.beautyTrend);
  await expect(page.locator("#mastery-goal")).toHaveValue(answers.masteryGoal);
  await expect(page.locator("#research-time")).toHaveValue(answers.researchTime);
  await expect(page.getByLabel("Email address")).toHaveValue("member-a@example.invalid");
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
  expect(submitted).toEqual([answers, answers]);
  expect(submissionIds).toHaveLength(2);
  expect(submissionIds[0]).toBeTruthy();
  expect(submissionIds[1]).toBe(submissionIds[0]);
  expect(saved).toHaveLength(1);
  expect(await tracking()).toEqual([
    { name: "radiant_audit_saved", data: { completion_kind: "first_time" } },
  ]);
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  await page.goto("/tests/audit-harness.html");
  await expect(page.locator("#mastery-goal")).toHaveValue("");
  await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
  // An intentional new submission uses a fresh ID, even for identical answers.
  await page.getByLabel("Skincare consistency").check();
  await page.getByLabel("Quality over price").check();
  await page.getByLabel("Professional results").check();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill("member-a@example.invalid");
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(submitted).toEqual([answers, answers, answers]);
  expect(submissionIds).toHaveLength(3);
  expect(submissionIds[2]).toBeTruthy();
  expect(submissionIds[2]).not.toBe(submissionIds[0]);
});

test("a signed-in draft never appears for another account and can be discarded", async ({ page }) => {
  await signInAs(page, "member-a");
  await page.getByLabel("Skincare consistency").check();
  await page.locator("#beauty-trend").fill("private account A answer");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, signedInDraftKey)).toBe(true);

  await page.evaluate(() => localStorage.setItem("audit-test-account", "member-b"));
  await page.reload();
  await expect(page.locator("#beauty-trend")).toHaveValue("");
  await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
  await expect(page.locator("body")).not.toContainText("private account A answer");
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();

  await page.locator("#mastery-goal").fill("account B draft");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, signedInDraftKey)).toBe(true);
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.locator("#mastery-goal")).toHaveValue("");
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  await page.reload();
  await expect(page.locator("#mastery-goal")).toHaveValue("");
});

test("an unfinished Audit continues in a separate browser, stays private, and disappears after saving", async ({ page, browser }) => {
  const drafts = new Map<string, Answers>();
  const draftUpdated = new Map<string, string>();
  const completed = new Map<string, Audit>();
  const discards = new Map<string, string>();
  const handler = async (route: import("@playwright/test").Route) => {
    const request = route.request();
    const account = request.headers().authorization?.replace("Bearer ", "");
    if (!account) return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/draft")) {
      if (request.method() === "GET") return route.fulfill({ json: drafts.has(account)
        ? { ...drafts.get(account)!, updatedAt: draftUpdated.get(account)! } : (
        discards.has(account) ? { discardedAt: discards.get(account) } : null
      ) });
      if (request.headers()["x-audit-draft-owner"] !== account) return route.fulfill({ status: 409 });
      if (request.method() === "DELETE") {
        drafts.delete(account);
        discards.set(account, new Date().toISOString());
        return route.fulfill({ status: 204 });
      }
      const answers = request.postDataJSON() as Answers;
      discards.delete(account);
      drafts.set(account, answers);
      draftUpdated.set(account, new Date().toISOString());
      return route.fulfill({ json: answers });
    }
    if (request.method() === "PUT") {
      drafts.delete(account);
      discards.delete(account);
      const { submissionId: _id, ...answers } = request.postDataJSON() as Answers & { submissionId: string };
      const audit = { ...answers, routineScore: 1, valuesScore: 1, completedAt: new Date().toISOString() };
      completed.set(account, audit);
      return route.fulfill({ json: {
        audit,
        completionKind: "first_time",
      } });
    }
    return route.fulfill({ json: path.endsWith("/history") ? [] : completed.get(account) ?? null });
  };
  await page.route("**/api/users/me/radiant-audit**", handler);
  await signInAs(page, "member-a");
  await page.getByLabel("Skincare consistency").check();
  await page.locator("#beauty-trend").fill("private cross-device trend");
  await expect.poll(() => drafts.get("member-a")?.beautyTrend).toBe("private cross-device trend");
  // A queued write created for A must not be accepted if the session changes to B.
  await page.evaluate(() => localStorage.setItem("audit-test-account", "member-b"));
  const rejected = page.waitForResponse(response =>
    response.url().endsWith("/api/users/me/radiant-audit/draft") &&
    response.request().method() === "PUT" && response.status() === 409,
  );
  await page.locator("#mastery-goal").fill("private pending from member A");
  await rejected;
  expect(drafts.has("member-b")).toBe(false);
  await page.reload();
  await expect(page.locator("body")).not.toContainText("private pending from member A");
  await signInAs(page, "member-a");

  const otherBrowser = await browser.newContext({ baseURL: "http://127.0.0.1:4179" });
  try {
    const secondPage = await otherBrowser.newPage();
    await secondPage.route("**/api/users/me/radiant-audit**", handler);
    await signInAs(secondPage, "member-b");
    await expect(secondPage.locator("#beauty-trend")).toHaveValue("");
    await expect(secondPage.locator("body")).not.toContainText("private cross-device trend");
    await signInAs(secondPage, "member-a");
    await expect(secondPage.locator("#beauty-trend")).toHaveValue("private cross-device trend");
    await expect(secondPage.getByLabel("Skincare consistency")).toBeChecked();
    await secondPage.locator("#beauty-trend").fill("newer answer on device two");
    await expect.poll(() => drafts.get("member-a")?.beautyTrend).toBe("newer answer on device two");
    await page.reload();
    await expect(page.locator("#beauty-trend")).toHaveValue("newer answer on device two");
    await secondPage.getByLabel("Quality over price").check();
    await secondPage.locator("#mastery-goal").fill("my goal");
    await secondPage.locator("#research-time").fill("one hour");
    await secondPage.getByRole("button", { name: "Save my Audit" }).click();
    await expect(secondPage.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    expect(drafts.has("member-a")).toBe(false);
    await page.reload();
    await expect(page.locator("#beauty-trend")).toHaveValue("");
    await page.locator("#beauty-trend").fill("discarded from another device");
    await expect.poll(() => drafts.get("member-a")?.beautyTrend).toBe("discarded from another device");
    await signInAs(secondPage, "member-a");
    await expect(secondPage.locator("#beauty-trend")).toHaveValue("discarded from another device");
    await secondPage.getByRole("button", { name: "Discard draft" }).click();
    await expect(secondPage.locator("#beauty-trend")).toHaveValue("");
    await page.reload();
    await expect(page.locator("#beauty-trend")).toHaveValue("");
  } finally {
    await otherBrowser.close();
  }
});

for (const scenario of ["expired", "unreadable JSON", "invalid answers"] as const) {
  test(`${scenario} signed-in drafts are removed without restoring answers, and a new draft remains editable`, async ({ page }) => {
    await signInAs(page, "member-a");
    const oldAnswer = `private ${scenario} answer`;
    await page.evaluate(({ key, scenario, oldAnswer }) => {
      const answers = {
        email: "member-a@example.invalid",
        routineChecks: ["skincare-consistency"],
        valuesChecks: ["quality-over-price"],
        beautyTrend: oldAnswer,
        masteryGoal: oldAnswer,
        researchTime: oldAnswer,
      };
      const record = { owner: "member-a", expiresAt: Date.now() + 60_000, answers };
      if (scenario === "expired") record.expiresAt = Date.now() - 1;
      if (scenario === "invalid answers") {
        (record.answers as { valuesChecks: unknown }).valuesChecks = "quality-over-price";
      }
      localStorage.setItem(key, scenario === "unreadable JSON"
        ? `{"owner":"member-a","answers":{"masteryGoal":"${oldAnswer}"`
        : JSON.stringify(record));
    }, { key: signedInDraftKey, scenario, oldAnswer });

    await page.reload();
    await expect(page.locator("#beauty-trend")).toHaveValue("");
    await expect(page.locator("#mastery-goal")).toHaveValue("");
    await expect(page.locator("#research-time")).toHaveValue("");
    await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
    await expect(page.getByLabel("Quality over price")).not.toBeChecked();
    await expect(page.locator("body")).not.toContainText(oldAnswer);
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();

    const freshAnswer = `fresh ${scenario} answer`;
    await page.getByLabel("Skincare consistency").check();
    await page.locator("#mastery-goal").fill(freshAnswer);
    await expect.poll(() => page.evaluate(key => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).answers.masteryGoal : null;
    }, signedInDraftKey)).toBe(freshAnswer);
    await page.reload();
    await expect(page.getByLabel("Skincare consistency")).toBeChecked();
    await expect(page.locator("#mastery-goal")).toHaveValue(freshAnswer);
    await expect(page.locator("body")).not.toContainText(oldAnswer);
  });
}
