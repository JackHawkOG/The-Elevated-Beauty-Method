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

type TrackingEvent = { name: string; data?: unknown };

test.beforeEach(async ({ page }) => {
  // Default draft API for tests concerned with other Audit flows.
  await page.route("**/api/users/me/radiant-audit/draft", route => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: null });
    if (method === "DELETE") return route.fulfill({ status: 204 });
    return route.fulfill({ json: route.request().postDataJSON() });
  });
});

test("dashboard does not claim a saved Audit is missing when its GET fails and recovers on retry", async ({ page }) => {
  const savedAudit: Audit = {
    ...fixture("saved"), routineScore: 1, valuesScore: 2,
    completedAt: "2026-09-02T12:00:00.000Z",
  };
  let auditGets = 0;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/users/me") return route.fulfill({ json: { membershipTier: "Free" } });
    if (path === "/api/dashboard/stats") {
      return route.fulfill({ json: { totalCourses: 0, totalLessons: 0, totalEnrollments: 0, totalCategories: 0 } });
    }
    if (path === "/api/users/me/beauty-method") return route.fulfill({ json: null });
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/users/me/radiant-audit", route => {
    auditGets += 1;
    if (auditGets === 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    return route.fulfill({ json: savedAudit });
  });

  await page.goto("/tests/audit-harness.html?page=/dashboard");
  await expect(page.getByRole("alert")).toContainText("We couldn't load your Audit right now");
  await expect(page.getByRole("link", { name: "Complete your Audit" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review your Audit" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry loading Audit" }).click();
  await expect(page.getByText("Your reflection is saved. Current routine: 1/5 · Your values: 2/5.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review your Audit" })).toHaveAttribute("href", "/radiant-audit/complete");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(auditGets).toBe(2);
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
    const { submissionId: _submissionId, stagedAt: _stagedAt, ...answers } = value;
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
  const stagedAt = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!)?.stagedAt as number,
  );
  expect(stagedId).toBeTruthy();
  expect(stagedAt).toBeGreaterThan(0);
  await page.evaluate(() => localStorage.setItem("audit-test-account", "corrected"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await expect(page.getByText(originalEmail, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct email and save my Audit" })).toBeDisabled();
  expect(writes).toHaveLength(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(await stagedInBrowser(page)).toEqual({ email: originalEmail, ...stagedAnswers });
  expect(await page.evaluate(() => {
    const { submissionId, stagedAt } = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!);
    return { submissionId, stagedAt };
  })).toEqual({ submissionId: stagedId, stagedAt });
  expect(writes).toHaveLength(0);

  await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
  await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer corrected", answers: stagedAnswers, submissionId: stagedId }]);
  expect(await stagedInBrowser(page)).toEqual({ email: correctedEmail, ...stagedAnswers });
  expect(await page.evaluate(() => {
    const { submissionId, stagedAt } = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!);
    return { submissionId, stagedAt };
  })).toEqual({ submissionId: stagedId, stagedAt });

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
  await expect.poll(() => stagedInBrowser(page)).toBeNull();
});

test("an old pending attempt waits for the current Audit and consent before a new retake", async ({ page }) => {
  const oldId = "old-unconfirmed-id";
  const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const current: Audit = {
    ...fixture("current"), routineScore: 1, valuesScore: 2,
    completedAt: "2026-09-02T12:00:00.000Z",
  };
  const writes: string[] = [];
  let failLoad = true;
  let loaded = 0;
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (route.request().method() === "PUT") {
      writes.push((route.request().postDataJSON() as { submissionId: string }).submissionId);
      return route.fulfill({ json: { audit: current, completionKind: "retake" } });
    }
    if (route.request().url().endsWith("/history")) return route.fulfill({ json: [] });
    loaded++;
    return failLoad ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) :
      route.fulfill({ json: current });
  });
  await stageVisitorAnswers(page);
  await page.evaluate(({ oldId, oldTime }) => {
    const key = "tebm:radiant-audit:pending";
    const stored = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...stored, submissionId: oldId, stagedAt: oldTime }));
    localStorage.setItem("audit-test-account", "original");
  }, { oldId, oldTime });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Review your pending Audit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try loading again" })).toBeVisible();
  expect(writes).toHaveLength(0);
  failLoad = false;
  await page.getByRole("button", { name: "Try loading again" }).click();
  await expect(page.getByText(/Your current Audit was saved on/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeVisible();
  expect(loaded).toBeGreaterThanOrEqual(2);
  expect(writes).toHaveLength(0);
  expect(await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!);
    return [value.submissionId, value.stagedAt];
  })).toEqual([oldId, oldTime]);
  await page.getByRole("button", { name: "Save as a new retake" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toBe(oldId);
  await expect.poll(() => stagedInBrowser(page)).toBeNull();
});

test("a fresh pending attempt retries automatically with its original ID and time", async ({ page }) => {
  const writes: string[] = [];
  let failed = true;
  const audit: Audit = {
    ...stagedAnswers, routineScore: 2, valuesScore: 2,
    completedAt: "2026-09-02T12:00:00.000Z",
  };
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
    writes.push((route.request().postDataJSON() as { submissionId: string }).submissionId);
    return failed ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) :
      route.fulfill({ json: { audit, completionKind: "first_time" } });
  });
  await stageVisitorAnswers(page);
  const original = await page.evaluate(() => {
    const { submissionId, stagedAt } = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!);
    return { submissionId, stagedAt };
  });
  await page.evaluate(() => localStorage.setItem("audit-test-account", "original"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toEqual([original.submissionId]);
  expect(await page.evaluate(() => {
    const { submissionId, stagedAt } = JSON.parse(sessionStorage.getItem("tebm:radiant-audit:pending")!);
    return { submissionId, stagedAt };
  })).toEqual(original);
  failed = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toEqual([original.submissionId, original.submissionId]);
});

test("an undated legacy attempt is reviewed even without a current Audit", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (route.request().method() === "PUT") {
      writes.push((route.request().postDataJSON() as { submissionId: string }).submissionId);
      return route.fulfill({ json: {
        audit: { ...stagedAnswers, routineScore: 2, valuesScore: 2, completedAt: new Date().toISOString() },
        completionKind: "first_time",
      } });
    }
    return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
  });
  await stageVisitorAnswers(page);
  await page.evaluate(() => {
    const key = "tebm:radiant-audit:pending";
    const stored = JSON.parse(sessionStorage.getItem(key)!);
    delete stored.stagedAt;
    sessionStorage.setItem(key, JSON.stringify(stored));
    localStorage.setItem("audit-test-account", "original");
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("button", { name: "Save as a new Audit" })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Save as a new Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("an unverified account cannot save staged answers, even when its email matches", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (route.request().method() === "PUT") writes.push(route.request().postData() ?? "");
    return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
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
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (route.request().method() === "PUT") writes.push(route.request().postData() ?? "");
    return route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null });
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

test("verification and account-switch buttons report their actual form and completion actions", async ({ page }) => {
  await captureAuditTracking(page);
  await page.route("**/api/users/me/radiant-audit**", route =>
    route.fulfill({ json: route.request().url().endsWith("/history") ? [] : null }),
  );
  await signInAs(page, "original");
  await page.evaluate(() => localStorage.setItem("audit-test-verified", "false"));
  await page.reload();
  await page.getByRole("button", { name: "Verify my email" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("audit-test-profile-opened"))).toBe("true");
  expect(await auditTracking(page)).toEqual([
    { name: "radiant_audit_verification_action", data: { action: "verify_email", location: "form" } },
  ]);
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await page.evaluate(() => localStorage.getItem("audit-test-account"))).toBeNull();
  expect(await auditTracking(page)).toEqual([
    { name: "radiant_audit_verification_action", data: { action: "verify_email", location: "form" } },
    { name: "radiant_audit_verification_action", data: { action: "switch_account", location: "form" } },
  ]);
  await page.evaluate(() => localStorage.setItem("audit-test-account", "original"));
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await page.getByRole("button", { name: "Verify my email" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("audit-test-profile-opened"))).toBe("true");
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await page.evaluate(() => localStorage.getItem("audit-test-account"))).toBeNull();
  expect(await auditTracking(page)).toEqual([
    { name: "radiant_audit_verification_action", data: { action: "verify_email", location: "completion" } },
    { name: "radiant_audit_verification_action", data: { action: "switch_account", location: "completion" } },
  ]);
});

test("a verified automatic save reports one private resumption only after confirmation", async ({ page }) => {
  await captureAuditTracking(page);
  let writes = 0;
  await page.route("**/api/users/me/radiant-audit**", route => {
    const request = route.request();
    if (request.method() === "PUT") {
      writes++;
      if (writes === 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      const answers = request.postDataJSON() as Answers;
      return route.fulfill({ json: {
        audit: { ...answers, routineScore: 2, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" },
        completionKind: "first_time",
      } });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : null });
  });
  await stageVisitorAnswers(page);
  await page.evaluate(() => {
    (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking = [];
    localStorage.setItem("audit-test-account", "original");
    localStorage.setItem("audit-test-verified", "false");
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await page.getByRole("button", { name: "Verify my email" }).click();
  expect(await auditTracking(page)).toEqual([
    { name: "radiant_audit_verification_action", data: { action: "verify_email", location: "completion" } },
  ]);
  await page.evaluate(() => localStorage.setItem("audit-test-verified", "true"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Try saving again" })).toBeVisible();
  expect(writes).toBe(1);
  expect(await auditTracking(page)).toEqual([]);
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toBe(2);
  await expect.poll(() => auditTracking(page)).toEqual([
    { name: "radiant_audit_saved", data: { completion_kind: "first_time" } },
    { name: "radiant_audit_resumed_after_verification", data: { location: "completion" } },
  ]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(await auditTracking(page)).toEqual([]);
  expect(writes).toBe(2);
});

test("saving as a different verified account does not claim the first account's verification recovery", async ({ page }) => {
  await captureAuditTracking(page);
  const writes: Array<{ account: string | undefined; answers: Answers }> = [];
  await page.route("**/api/users/me/radiant-audit**", route => {
    const request = route.request();
    if (request.method() === "PUT") {
      const { submissionId: _submissionId, ...answers } = request.postDataJSON() as Answers & { submissionId: string };
      writes.push({ account: request.headers().authorization, answers });
      return route.fulfill({ json: {
        audit: { ...answers, routineScore: 2, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" },
        completionKind: "first_time",
      } });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : null });
  });

  await stageVisitorAnswers(page);
  await page.evaluate(() => {
    localStorage.setItem("audit-test-account", "original");
    localStorage.setItem("audit-test-verified", "false");
  });
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  await page.getByRole("button", { name: "Verify my email" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("radiant_audit_verification_account"))).toBe("original");
  expect(writes).toHaveLength(0);

  // Switch identities without the Audit switch button, so the first account's marker remains.
  await page.evaluate(() => {
    localStorage.setItem("audit-test-account", "corrected");
    localStorage.setItem("audit-test-verified", "true");
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email address" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("radiant_audit_verification_account"))).toBe("original");
  expect(writes).toHaveLength(0);
  await page.getByRole("checkbox", { name: /I confirm that these are my Audit answers/ }).check();
  await page.getByRole("button", { name: "Correct email and save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  expect(writes).toEqual([{ account: "Bearer corrected", answers: stagedAnswers }]);
  await expect.poll(() => auditTracking(page)).toEqual([
    { name: "radiant_audit_saved", data: { completion_kind: "first_time" } },
  ]);
  expect(JSON.stringify(await auditTracking(page))).not.toMatch(/@|private|original|corrected/);
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
  await page.evaluate(({ key, answers, email }) => localStorage.setItem(key, JSON.stringify({
    owner: "corrected", expiresAt: Date.now() + 86_400_000,
    answers: { ...answers, email },
  })), { key: signedInDraftKey, answers: stagedAnswers, email: correctedEmail });
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
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
  const tracking: TrackingEvent[] = [];
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

test("returning to a long-open Audit refreshes another device's change without switching the deletion target", async ({ page }) => {
  const makeEntry = (id: number, tag: string, completedAt: string): HistoryEntry => ({
    id, ...fixture(tag), completedAt, routineScore: 1, valuesScore: 2,
  });
  const removed = makeEntry(101, "first", "2026-09-01T12:00:00.000Z");
  const remaining = makeEntry(202, "second", "2026-09-02T12:00:00.000Z");
  const latest = makeEntry(303, "third", "2026-09-03T12:00:00.000Z");
  let history = [remaining, removed];
  let historyReads = 0;
  const deletes: number[] = [];
  await page.route("**/api/users/me/radiant-audit**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path.endsWith("/history")) {
      historyReads++;
      return route.fulfill({ json: history });
    }
    if (route.request().method() === "GET") return route.fulfill({ json: latest });
    if (route.request().method() === "DELETE" && path.includes("/history/")) {
      const id = Number(path.split("/").at(-1));
      deletes.push(id);
      history = history.filter(entry => entry.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405 });
  });
  await signInAs(page, "member-a");
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  const comparison = page.getByRole("region", { name: "How your answers have changed" });
  const select = comparison.getByRole("combobox", { name: "Compare with" });
  await select.selectOption("101");
  await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("ID 101");
  history = [remaining];
  const readsBeforeRefresh = historyReads;
  // Headless Chromium does not consistently dispatch focus when bringing a tab forward.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => historyReads).toBeGreaterThan(readsBeforeRefresh);
  await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeDisabled();
  await expect(dialog).toContainText("ID 101");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(comparison.getByRole("button", { name: "Delete selected earlier Audit" })).toBeDisabled();
  await expect(select).toHaveValue("");
  expect(deletes).toEqual([]);
  await page.reload();
  await expect(select).toHaveValue("");
  await expect(comparison.getByRole("button", { name: "Delete selected earlier Audit" })).toBeDisabled();
  await select.selectOption("202");
  await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
  await expect(dialog).toContainText("ID 202");
  await dialog.getByRole("button", { name: "Delete earlier Audit" }).click();
  await expect.poll(() => deletes).toEqual([202]);
});

test("deleting and clearing history updates another open tab even during confirmation", async ({ page, context }) => {
  const makeEntry = (id: number, tag: string, completedAt: string): HistoryEntry => ({
    id, ...fixture(tag), completedAt, routineScore: 1, valuesScore: 2,
  });
  const removed = makeEntry(101, "first", "2026-09-01T12:00:00.000Z");
  const remaining = makeEntry(202, "second", "2026-09-02T12:00:00.000Z");
  const latest = makeEntry(303, "third", "2026-09-03T12:00:00.000Z");
  let history = [remaining, removed];
  const deletes: number[] = [];
  let clears = 0;
  await context.route("**/api/users/me/radiant-audit**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path.endsWith("/history")) {
      return route.fulfill({ json: history });
    }
    if (route.request().method() === "GET") return route.fulfill({ json: latest });
    if (route.request().method() === "DELETE" && path.endsWith("/history")) {
      clears++;
      history = [];
      return route.fulfill({ status: 204 });
    }
    if (route.request().method() === "DELETE" && path.includes("/history/")) {
      const id = Number(path.split("/").at(-1));
      deletes.push(id);
      history = history.filter(entry => entry.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405 });
  });
  await signInAs(page, "member-a");
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  const otherTab = await context.newPage();
  await otherTab.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  const comparison = page.getByRole("region", { name: "How your answers have changed" });
  const otherComparison = otherTab.getByRole("region", { name: "How your answers have changed" });
  await comparison.getByRole("combobox", { name: "Compare with" }).selectOption("101");
  await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("ID 101");

  await otherComparison.getByRole("combobox", { name: "Compare with" }).selectOption("101");
  await otherComparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
  await otherTab.getByRole("alertdialog").getByRole("button", { name: "Delete earlier Audit" }).click();
  await expect.poll(() => deletes).toEqual([101]);
  await expect(dialog).toContainText("That submission is no longer in your history");
  await expect(dialog).toContainText("ID 101");
  await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(comparison.getByRole("combobox", { name: "Compare with" })).toHaveValue("");
  await expect(comparison.getByRole("button", { name: "Delete selected earlier Audit" })).toBeDisabled();

  await comparison.getByRole("combobox", { name: "Compare with" }).selectOption("202");
  await comparison.getByRole("button", { name: "Delete selected earlier Audit" }).click();
  await expect(dialog).toContainText("ID 202");
  await otherComparison.getByRole("button", { name: "Clear earlier history" }).click();
  await otherTab.getByRole("alertdialog").getByRole("button", { name: "Clear earlier history" }).click();
  await expect.poll(() => clears).toBe(1);
  await expect(dialog).toContainText("That submission is no longer in your history");
  await expect(dialog).toContainText("ID 202");
  await expect(dialog.getByRole("button", { name: "Delete earlier Audit" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/No earlier Audits remain/)).toBeVisible();
  expect(deletes).toEqual([101]);
});

test("history deletion signals only refresh the tab's current member after an account switch", async ({ page, context }) => {
  const entry = (id: number, tag: string): HistoryEntry => ({
    id, ...fixture(tag), completedAt: "2026-09-01T12:00:00.000Z",
    routineScore: 1, valuesScore: 1,
  });
  const history = new Map<string, HistoryEntry[]>([
    ["member-a", [entry(101, "a-first"), entry(102, "a-second")]],
    ["member-b", [entry(201, "b-first")]],
  ]);
  const current = new Map<string, Audit>([
    ["member-a", entry(301, "a-current")],
    ["member-b", entry(302, "b-current")],
  ]);
  const historyReads: string[] = [];
  const handleAudit = (route: import("@playwright/test").Route, trackReads = false) => {
    const request = route.request();
    const account = request.headers().authorization?.replace(/^Bearer /, "") ?? "";
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path.endsWith("/history")) {
      if (trackReads) historyReads.push(account);
      return route.fulfill({ json: history.get(account) ?? [] });
    }
    if (request.method() === "GET") return route.fulfill({ json: current.get(account) ?? null });
    if (request.method() === "DELETE" && path.includes("/history/")) {
      const id = Number(path.split("/").at(-1));
      history.set(account, (history.get(account) ?? []).filter(item => item.id !== id));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 405 });
  };
  await context.route("**/api/users/me/radiant-audit**", route => handleAudit(route));
  await signInAs(page, "member-a");
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(page.getByRole("region", { name: "How your answers have changed" })).toContainText("a-first private goal");

  const otherTab = await context.newPage();
  await otherTab.addInitScript(() => {
    sessionStorage.setItem("audit-test-tab-account", "member-b");
    (window as unknown as { __historySignals: string[] }).__historySignals = [];
    window.addEventListener("storage", event => {
      if (event.key?.startsWith("radiant-audit:history-changed:")) {
        (window as unknown as { __historySignals: string[] }).__historySignals.push(event.key);
      }
    });
  });
  await otherTab.route("**/api/users/me/radiant-audit**", route => handleAudit(route, true));
  await otherTab.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  const comparison = otherTab.getByRole("region", { name: "How your answers have changed" });
  await expect(comparison).toContainText("b-first private goal");
  await expect(otherTab.getByText("b-current private goal").first()).toBeVisible();
  expect(historyReads).toEqual(["member-b"]);

  const deleteEntry = async (writer: Page, id: number) => {
    const picker = writer.getByRole("region", { name: "How your answers have changed" });
    await picker.getByRole("combobox", { name: "Compare with" }).selectOption(String(id));
    await picker.getByRole("button", { name: "Delete selected earlier Audit" }).click();
    await writer.getByRole("alertdialog").getByRole("button", { name: "Delete earlier Audit" }).click();
    await expect(picker.getByRole("combobox", { name: "Compare with" }).locator(`option[value="${id}"]`)).toHaveCount(0);
  };
  const waitForSignal = async (key: string, count: number) => {
    await expect.poll(() => otherTab.evaluate(() =>
      (window as unknown as { __historySignals: string[] }).__historySignals,
    )).toContainEqual(key);
    await expect.poll(() => otherTab.evaluate(() =>
      (window as unknown as { __historySignals: string[] }).__historySignals.length,
    )).toBe(count);
    // The storage event has arrived; give any incorrectly scheduled query invalidation time to run.
    await otherTab.waitForTimeout(150);
  };

  await deleteEntry(page, 101);
  await waitForSignal("radiant-audit:history-changed:member-a", 1);
  expect(historyReads).toEqual(["member-b"]);
  await expect(comparison).toContainText("b-first private goal");

  await otherTab.evaluate(() => {
    sessionStorage.setItem("audit-test-tab-account", "member-a");
    window.dispatchEvent(new Event("audit-test-auth-change"));
  });
  // A different member's deletion must now be ignored by the replaced listener.
  const bWriter = await context.newPage();
  await bWriter.addInitScript(() => sessionStorage.setItem("audit-test-tab-account", "member-b"));
  await bWriter.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(bWriter.getByRole("region", { name: "How your answers have changed" })).toContainText("b-first private goal");
  await deleteEntry(bWriter, 201);
  await waitForSignal("radiant-audit:history-changed:member-b", 2);
  expect(historyReads).toEqual(["member-b"]);

  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await deleteEntry(page, 102);
  await waitForSignal("radiant-audit:history-changed:member-a", 3);
  await expect.poll(() => historyReads).toEqual(["member-b", "member-a"]);
  await expect(otherTab.getByText("a-current private goal").first()).toBeVisible();
  await expect(otherTab.getByText("b-current private goal")).toHaveCount(0);
  await expect(otherTab.getByText(/No earlier Audits remain/)).toBeVisible();
});

test("a retake refreshes the current Audit and new history in another open tab", async ({ page, context }) => {
  const previous: Audit = {
    ...fixture("first"), completedAt: "2026-09-01T12:00:00.000Z",
    routineScore: 1, valuesScore: 1,
  };
  let current = previous;
  let history: HistoryEntry[] = [];
  await context.route("**/api/users/me/radiant-audit**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      return route.fulfill({ json: path.endsWith("/history") ? history : current });
    }
    if (route.request().method() === "PUT" && !path.endsWith("/draft")) {
      history = [{ id: 101, ...current }];
      const answers = route.request().postDataJSON() as Answers;
      current = {
        ...answers, completedAt: "2026-09-02T12:00:00.000Z",
        routineScore: answers.routineChecks.length, valuesScore: answers.valuesChecks.length,
      };
      return route.fulfill({ json: { audit: current, completionKind: "retake" } });
    }
    return route.fulfill({ status: 405 });
  });
  await signInAs(page, "member-a");
  const waitingTab = await context.newPage();
  await waitingTab.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await expect(waitingTab.getByText("first private goal")).toBeVisible();
  await page.goto("/tests/audit-harness.html");
  await submit(page, "second");

  const comparison = waitingTab.getByRole("region", { name: "How your answers have changed" });
  await expect(comparison.getByRole("combobox", { name: "Compare with" }).locator("option")).toHaveCount(1);
  await expect(comparison.getByRole("heading", { name: /^Earlier ·/ })).toBeVisible();
  await expect(comparison).toContainText("first private goal");
  await expect(comparison).toContainText("second private goal");
  await expect(waitingTab.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
});

test("a committed signed-in save with a lost response retries after reload without creating history", async ({ page }) => {
  const answers = fixture("lost-response");
  const submissionIds: string[] = [];
  let current: Audit | null = null;
  const history: HistoryEntry[] = [];
  let firstResponseDropped = false;

  await page.route("**/api/users/me/radiant-audit**", async route => {
    const request = route.request();
    if (request.headers().authorization !== "Bearer member-a") {
      return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    }
    if (request.method() === "GET") {
      return route.fulfill({ json: new URL(request.url()).pathname.endsWith("/history") ? history : current });
    }
    if (request.method() !== "PUT") return route.fulfill({ status: 405 });
    const { submissionId, ...input } = request.postDataJSON() as Answers & { submissionId: string };
    submissionIds.push(submissionId);
    if (!current) {
      current = {
        ...input,
        routineScore: input.routineChecks.length,
        valuesScore: input.valuesChecks.length,
        completedAt: "2026-09-02T12:00:00.000Z",
      };
    } else if (submissionId !== submissionIds[0]) {
      history.push({ id: history.length + 1, ...current });
      current = { ...current, ...input };
    }
    // The server committed the write, but the browser never receives its confirmation.
    if (!firstResponseDropped) {
      firstResponseDropped = true;
      return route.abort("failed");
    }
    return route.fulfill({ json: { audit: current, completionKind: "first_time" } });
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
  expect(firstResponseDropped).toBe(true);
  expect(submissionIds).toHaveLength(1);
  expect(submissionIds[0]).toBeTruthy();
  expect(current).toMatchObject(answers);
  expect(history).toEqual([]);
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toHaveCount(0);

  await page.reload();
  await expect(page.locator("#mastery-goal")).toHaveValue(answers.masteryGoal);
  await expect(page.getByLabel("Skincare consistency")).toBeChecked();
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
  expect(submissionIds).toEqual([submissionIds[0], submissionIds[0]]);
  expect(history).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();

  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "How your answers have changed" })).toHaveCount(0);
  expect(submissionIds).toHaveLength(2);
  expect(history).toEqual([]);
});

for (const storageFailure of ["read throws", "write throws", "write ignored"] as const) {
  test(`a lost signed-in response keeps its retry ID when draft storage ${storageFailure}`, async ({ page }) => {
    const answers = fixture("restricted-storage");
    const submissionIds: string[] = [];
    const history: HistoryEntry[] = [];
    let current: Audit | null = null;
    await page.addInitScript(({ key, failure }) => {
      const originalGet = Storage.prototype.getItem;
      const originalSet = Storage.prototype.setItem;
      const state = { failing: true };
      (window as unknown as { __auditStorage: typeof state }).__auditStorage = state;
      Storage.prototype.getItem = function (name) {
        if (state.failing && name === key && failure === "read throws") throw new Error("Storage disabled");
        return originalGet.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (state.failing && name === key) {
          if (failure === "write throws") throw new Error("Quota exceeded");
          if (failure === "write ignored") return;
        }
        originalSet.call(this, name, value);
      };
    }, { key: signedInDraftKey, failure: storageFailure });
    await page.route("**/api/users/me/radiant-audit**", route => {
      const request = route.request();
      if (request.method() === "GET") {
        return route.fulfill({ json: request.url().endsWith("/history") ? history : current });
      }
      const { submissionId, ...input } = request.postDataJSON() as Answers & { submissionId: string };
      submissionIds.push(submissionId);
      if (!current || submissionId !== submissionIds[0]) {
        if (current) history.push({ id: history.length + 1, ...current });
        current = { ...input, routineScore: 1, valuesScore: 2, completedAt: new Date().toISOString() };
      }
      if (submissionIds.length === 1 || (storageFailure === "write ignored" && submissionIds.length === 2))
        return route.abort("failed");
      return route.fulfill({ json: { audit: current, completionKind: "first_time" } });
    });
    // Online drafts do not store retry IDs and cannot substitute for browser protection.
    await page.route("**/api/users/me/radiant-audit/draft", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: null });
      return route.fulfill({ json: { ...route.request().postDataJSON(), updatedAt: new Date().toISOString() } });
    });
    await signInAs(page, "member-a");
    const fillAnswers = async () => {
      await page.getByLabel("Skincare consistency").check();
      await page.getByLabel("Quality over price").check();
      await page.getByLabel("Professional results").check();
      await page.locator("#beauty-trend").fill(answers.beautyTrend);
      await page.locator("#mastery-goal").fill(answers.masteryGoal);
      await page.locator("#research-time").fill(answers.researchTime);
      await page.getByLabel("Email address").fill("member-a@example.invalid");
    };
    await fillAnswers();
    await page.getByRole("button", { name: "Save my Audit" }).click();
    // The modal intentionally hides the underlying page from assistive technology.
    const warning = page.getByRole("alert", { includeHidden: true }).filter({ hasText: "Keep this page open to retry safely" });
    await expect(warning).toContainText("couldn't keep your Audit retry protection across reloads");
    await expect(warning).toContainText("could create a duplicate retake");
    await expect(page.getByRole("alertdialog")).toContainText("There is no current Audit");
    expect(submissionIds).toEqual([]);
    await page.getByRole("button", { name: "Save as a new Audit" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "We couldn't save your Audit" })).toContainText("It may already be saved");
    expect(submissionIds).toHaveLength(1);
    expect(submissionIds[0]).toBeTruthy();
    expect(current).toMatchObject(answers);
    await expect(warning).toBeVisible();

    if (storageFailure === "write throws") {
      // Recovering storage and editing must not silently rotate an unconfirmed ID.
      await page.evaluate(() => {
        (window as unknown as { __auditStorage: { failing: boolean } }).__auditStorage.failing = false;
      });
      await page.locator("#mastery-goal").fill("Edited after an uncertain save");
      await expect(warning).toBeVisible();
      await page.getByRole("button", { name: "Save my Audit" }).click();
      await expect(page.getByRole("alertdialog")).toContainText("these answers changed");
      await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeEnabled();
      expect(submissionIds).toHaveLength(1);
      await page.getByRole("button", { name: "Keep editing" }).click();
      await page.locator("#mastery-goal").fill(answers.masteryGoal);
    }
    if (storageFailure === "write ignored") {
      await page.getByRole("button", { name: "Save my Audit" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "We couldn't save your Audit" })).toBeVisible();
      expect(submissionIds).toEqual([submissionIds[0], submissionIds[0]]);
      // Reload has lost the memory-only ID. Even re-entering identical answers
      // must review the committed Audit, not automatically create a retake.
      await page.reload();
      await fillAnswers();
      await page.getByRole("button", { name: "Save my Audit" }).click();
      await expect(page.getByRole("alertdialog")).toContainText("A previous save may already have succeeded");
      await expect(page.getByRole("button", { name: "Save as a new retake" })).toBeEnabled();
      expect(submissionIds).toHaveLength(2);
      expect(history).toEqual([]);
      await page.getByRole("button", { name: "Keep editing" }).click();
      expect(submissionIds).toHaveLength(2);
      return;
    }

    await page.getByRole("button", { name: "Save my Audit" }).click();
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    expect(submissionIds).toEqual([submissionIds[0], submissionIds[0]]);
    expect(history).toEqual([]);
    await expect(page.getByText(answers.masteryGoal).first()).toBeVisible();
  });
}

for (const scenario of ["expired", "unknown-age"] as const) {
  test(`a signed-in ${scenario} retry waits for current Audit review and explicit new save`, async ({ page }) => {
    const answers = fixture(scenario);
    await page.addInitScript(() => {
      const events: Array<{ name: string; data?: unknown }> = [];
      (window as unknown as { __auditTracking: typeof events }).__auditTracking = events;
      (window as unknown as { umami: { track: (name: string, data?: unknown) => void } }).umami = {
        track: (name, data) => { events.push({ name, data }); },
      };
    });
    const tracking = () => page.evaluate(() =>
      (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking,
    );
    const oldId = crypto.randomUUID();
    const writes: string[] = [];
    let reads = 0;
    let failReview = false;
    const current: Audit | null = scenario === "expired" ? {
      ...fixture("already-saved"), routineScore: 1, valuesScore: 2,
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    } : null;
    let savedCurrent = current;
    await page.route("**/api/users/me/radiant-audit/history", route => route.fulfill({ json: [] }));
    await page.route("**/api/users/me/radiant-audit", route => {
      if (route.request().method() === "GET") {
        reads++;
        if (failReview) {
          failReview = false;
          return route.fulfill({ status: 503, json: { error: "Unavailable" } });
        }
        return route.fulfill({ json: savedCurrent });
      }
      const { submissionId, ...input } = route.request().postDataJSON() as Answers & { submissionId: string };
      writes.push(submissionId);
      savedCurrent = { ...input, routineScore: 1, valuesScore: 2, completedAt: new Date().toISOString() };
      return route.fulfill({ json: {
        audit: savedCurrent,
        completionKind: current ? "retake" : "first_time",
      } });
    });
    await signInAs(page, "member-a");
    // Seed away from the form so its initial empty-draft effect cannot clear the fixture.
    await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
    const startedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await page.evaluate(({ key, answers, id, startedAt, scenario }) => {
      localStorage.setItem(key, JSON.stringify({
        owner: "member-a", expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        answers: { ...answers, email: "member-a@example.invalid" },
        submissionId: id,
        ...(scenario === "expired" ? { submissionStartedAt: startedAt } : {}),
      }));
    }, { key: signedInDraftKey, answers, id: oldId, startedAt, scenario });
    await page.goto("/tests/audit-harness.html");
    await expect(page.locator("#mastery-goal")).toHaveValue(answers.masteryGoal);
    // Editing refreshes the draft, but must not refresh the submission's age.
    await page.locator("#mastery-goal").fill(`${answers.masteryGoal} edited`);
    await expect.poll(() => page.evaluate(key =>
      JSON.parse(localStorage.getItem(key)!).answers.masteryGoal, signedInDraftKey,
    )).toBe(`${answers.masteryGoal} edited`);
    const record = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), signedInDraftKey);
    expect(record.submissionStartedAt).toBe(scenario === "expired" ? startedAt : null);
    const priorReads = reads;
    failReview = true;
    await page.getByRole("button", { name: "Save my Audit" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("couldn't load your current Audit");
    expect(reads).toBeGreaterThan(priorReads);
    expect(writes).toEqual([]);
    expect(await tracking()).toEqual([]);
    await page.getByRole("button", { name: "Try loading again" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(current ? "will create a new retake" : "will create a new Audit");
    expect(writes).toEqual([]);
    const reviewed: TrackingEvent = {
      name: "radiant_audit_expired_retry_reviewed",
      data: { has_current_audit: current !== null },
    };
    expect(await tracking()).toEqual([reviewed]);
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    expect(writes).toEqual([]);
    expect(await tracking()).toEqual([reviewed]);
    await page.getByRole("button", { name: "Save my Audit" }).click();
    await expect(dialog).toContainText(current ? "will create a new retake" : "will create a new Audit");
    expect(writes).toEqual([]);
    expect(await tracking()).toEqual([reviewed, reviewed]);
    await dialog.getByRole("button", { name: current ? "Save as a new retake" : "Save as a new Audit" }).click();
    expect(writes).toHaveLength(1);
    await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
    expect(writes[0]).not.toBe(oldId);
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
    // Exact payloads exclude all answer text, email, account and submission IDs.
    expect(await tracking()).toEqual([
      reviewed, reviewed,
      {
        name: "radiant_audit_expired_retry_new_save_selected",
        data: { has_current_audit: current !== null },
      },
      { name: "radiant_audit_saved", data: { completion_kind: current ? "retake" : "first_time" } },
    ]);
  });
}

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
  // Keep background draft writes distinct from the completed-Audit PUTs counted above.
  await page.route("**/api/users/me/radiant-audit/draft", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: null });
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    return route.fulfill({ json: route.request().postDataJSON() });
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
  await page.reload();
  await expect(page.locator("#mastery-goal")).toHaveValue("");
  await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
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

test("a form change after confirmed save cannot recreate local or online unfinished answers before navigation", async ({ page }) => {
  const answers = fixture("transition");
  let current: Audit = {
    ...fixture("previous"), routineScore: 1, valuesScore: 2,
    completedAt: "2026-09-01T12:00:00.000Z",
  };
  let onlineDraft: (Answers & { updatedAt: string }) | null = null;
  const draftWrites: Answers[] = [];
  let confirmed = false;
  await page.route("**/api/users/me/radiant-audit**", route => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({ json: request.url().endsWith("/history") ? [] : current });
    }
    expect(request.method()).toBe("PUT");
    const { submissionId, ...input } = request.postDataJSON();
    expect(submissionId).toBeTruthy();
    expect(input).toEqual(answers);
    current = { ...input, routineScore: 1, valuesScore: 2, completedAt: "2026-09-02T12:00:00.000Z" };
    // The completed-Audit endpoint clears the unfinished server draft.
    onlineDraft = null;
    confirmed = true;
    return route.fulfill({ json: { audit: current, completionKind: "retake" } });
  });
  await page.route("**/api/users/me/radiant-audit/draft", route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: onlineDraft });
    if (request.method() === "DELETE") {
      onlineDraft = null;
      return route.fulfill({ status: 204 });
    }
    expect(request.method()).toBe("PUT");
    const input = request.postDataJSON() as Answers;
    draftWrites.push(input);
    onlineDraft = { ...input, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: onlineDraft });
  });
  await signInAs(page, "member-a");
  await page.goto("/tests/audit-harness.html?holdSaveNavigation=1");
  await page.getByLabel("Skincare consistency").check();
  await page.getByLabel("Quality over price").check();
  await page.getByLabel("Professional results").check();
  await page.locator("#beauty-trend").fill(answers.beautyTrend);
  await page.locator("#mastery-goal").fill(answers.masteryGoal);
  await page.locator("#research-time").fill(answers.researchTime);
  await page.getByLabel("Email address").fill("member-a@example.invalid");
  // Prove both persistence paths were active before submission.
  await expect.poll(() => onlineDraft?.masteryGoal).toBe(answers.masteryGoal);
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toContain(answers.masteryGoal);
  await page.getByRole("button", { name: "Save my Audit" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __auditNavigation: { pending: string | null } }).__auditNavigation.pending,
  )).toBe("/radiant-audit/complete");
  expect(confirmed).toBe(true);
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(onlineDraft).toBeNull();

  const writeCount = draftWrites.length;
  await page.clock.install();
  // Use the actual input and React effect, not a synthetic persistence call.
  await page.locator("#mastery-goal").fill(`${answers.masteryGoal} late change`);
  await expect(page.locator("#mastery-goal")).toHaveValue(`${answers.masteryGoal} late change`);
  await page.clock.runFor(1_000); // Beyond the 600ms online autosave debounce.
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(onlineDraft).toBeNull();
  expect(draftWrites).toHaveLength(writeCount);
  await page.evaluate(() =>
    (window as unknown as { __auditNavigation: { release: () => void } }).__auditNavigation.release(),
  );
  await expect(page.getByRole("heading", { name: "Your Radiant Audit" })).toBeVisible();
  await expect(page.getByText(answers.masteryGoal, { exact: true })).toBeVisible();
  await page.goto("/tests/audit-harness.html");
  await expect(page.locator("#mastery-goal")).toHaveValue("");
  await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(onlineDraft).toBeNull();
});

test("late form changes during explicit discard cannot restore old answers, but fresh edits survive", async ({ page }) => {
  const discarded = fixture("discard-transition");
  const fresh = fixture("fresh-after-discard");
  const current: Audit = {
    ...fixture("completed-before-discard"), routineScore: 1, valuesScore: 2,
    completedAt: "2026-09-01T12:00:00.000Z",
  };
  let online: (Answers & { updatedAt: string }) | { discardedAt: string } | null = null;
  const draftWrites: Answers[] = [];
  let deleteStarted = false;
  let markerReadStarted = false;
  let holdMarkerRead = false;
  let releaseDelete!: () => void;
  let releaseMarkerRead!: () => void;
  const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
  const markerGate = new Promise<void>(resolve => { releaseMarkerRead = resolve; });
  // No Clerk, database, or real-member API access, including destination reads.
  await page.route("**/api/**", route => {
    const request = route.request();
    expect(request.method()).toBe("GET");
    expect(new URL(request.url()).pathname).toMatch(/^\/api\/users\/me\/radiant-audit(?:\/history)?$/);
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : current });
  });
  await page.route("**/api/users/me/radiant-audit/draft", async route => {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer member-a");
    if (request.method() === "GET") {
      if (holdMarkerRead) {
        markerReadStarted = true;
        await markerGate;
        holdMarkerRead = false;
      }
      return route.fulfill({ json: online });
    }
    if (request.method() === "DELETE") {
      deleteStarted = true;
      await deleteGate;
      online = { discardedAt: new Date().toISOString() };
      holdMarkerRead = true;
      return route.fulfill({ status: 204 });
    }
    expect(request.method()).toBe("PUT");
    const revision = online
      ? ("discardedAt" in online ? online.discardedAt : online.updatedAt) : "none";
    expect(request.headers()["x-audit-draft-revision"]).toBe(revision);
    expect(request.headers()["x-audit-draft-baseline"]).toBe(current.completedAt);
    const input = request.postDataJSON() as Answers;
    draftWrites.push(input);
    online = { ...input, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: online });
  });
  const storageWrites = () => page.evaluate(() =>
    (window as unknown as { __auditDraftStorage: { writes: string[] } }).__auditDraftStorage.writes);
  try {
    await signInAs(page, "member-a");
    await page.goto("/tests/audit-harness.html?observeDraftWrites=1");
    await page.getByLabel("Skincare consistency").check();
    await page.getByLabel("Quality over price").check();
    await page.getByLabel("Professional results").check();
    await page.locator("#beauty-trend").fill(discarded.beautyTrend);
    await page.locator("#mastery-goal").fill(discarded.masteryGoal);
    await page.locator("#research-time").fill(discarded.researchTime);
    await expect.poll(() => online && "masteryGoal" in online ? online.masteryGoal : null).toBe(discarded.masteryGoal);
    await expect.poll(() => storageWrites()).not.toEqual([]);
    const localBefore = await page.evaluate(key => localStorage.getItem(key), signedInDraftKey);
    expect(localBefore).toContain(discarded.masteryGoal);
    const localWriteCount = (await storageWrites()).length;
    const onlineWriteCount = draftWrites.length;
    await page.clock.install();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect.poll(() => deleteStarted).toBe(true);
    // Edit the real still-mounted form while DELETE is held.
    await page.locator("#mastery-goal").fill(`${discarded.masteryGoal} late during deletion`);
    await expect(page.locator("#mastery-goal")).toHaveValue(`${discarded.masteryGoal} late during deletion`);
    await page.clock.runFor(1_000);
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBe(localBefore);
    expect((await storageWrites()).length).toBe(localWriteCount);
    expect(draftWrites).toHaveLength(onlineWriteCount);

    releaseDelete();
    await expect.poll(() => markerReadStarted).toBe(true);
    // Deletion is confirmed, but the revision read and form reset are still pending.
    await page.locator("#beauty-trend").fill(`${discarded.beautyTrend} late before reset`);
    await page.getByLabel("Skincare consistency").uncheck();
    await page.clock.runFor(1_000);
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBe(localBefore);
    expect((await storageWrites()).length).toBe(localWriteCount);
    expect(draftWrites).toHaveLength(onlineWriteCount);
    expect(online).toHaveProperty("discardedAt");

    await page.evaluate(() => {
      const observed = window as unknown as {
        __auditDraftStorage: { onClear: (() => void) | null };
        __auditResetChange: string | null;
      };
      observed.__auditResetChange = null;
      observed.__auditDraftStorage.onClear = () => {
        const input = document.querySelector<HTMLTextAreaElement>("#research-time")!;
        // Use the native input setter so React sees the changed value and runs
        // the real form's onChange and draft effect, not a persistence mock.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
          .call(input, "discarded late reset answer");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        observed.__auditResetChange = input.value;
      };
    });
    releaseMarkerRead();
    await expect(page.locator("#mastery-goal")).toHaveValue("");
    expect(await page.evaluate(() =>
      (window as unknown as { __auditResetChange: string | null }).__auditResetChange,
    )).toBe("discarded late reset answer");
    await expect(page.locator("#beauty-trend")).toHaveValue("");
    await expect(page.locator("#research-time")).toHaveValue("");
    await expect(page.getByLabel("Skincare consistency")).not.toBeChecked();
    await expect(page.getByLabel("Quality over price")).not.toBeChecked();
    await expect(page.getByLabel("Professional results")).not.toBeChecked();
    await page.clock.runFor(1_000);
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
    expect((await storageWrites()).length).toBe(localWriteCount);
    expect(draftWrites).toHaveLength(onlineWriteCount);
    expect(online).toHaveProperty("discardedAt");

    // On this same mounted page, the guard must end with discard rather than
    // disabling persistence until a reload. Observe all reset-to-fresh writes.
    await page.evaluate(() => {
      (window as unknown as { __auditDraftStorage: { writes: string[] } }).__auditDraftStorage.writes = [];
    });
    await page.getByLabel("Skincare consistency").check();
    await page.getByLabel("Quality over price").check();
    await page.getByLabel("Professional results").check();
    await page.locator("#beauty-trend").fill(fresh.beautyTrend);
    await page.locator("#mastery-goal").fill(fresh.masteryGoal);
    await page.locator("#research-time").fill(fresh.researchTime);
    await page.clock.runFor(1_000);
    await expect.poll(() => online && "masteryGoal" in online ? online.masteryGoal : null).toBe(fresh.masteryGoal);
    expect(draftWrites.slice(onlineWriteCount)).toEqual([fresh]);
    const localFresh = await page.evaluate(key => localStorage.getItem(key), signedInDraftKey);
    expect(JSON.parse(localFresh!).answers).toMatchObject(fresh);
    expect(localFresh).not.toContain(discarded.beautyTrend);
    expect(localFresh).not.toContain(current.masteryGoal);
    expect(localFresh).not.toContain("discarded late reset answer");
    for (const raw of await storageWrites()) {
      expect(raw).not.toContain(discarded.beautyTrend);
      expect(raw).not.toContain(current.masteryGoal);
      expect(raw).not.toContain("discarded late reset answer");
    }
    await page.reload();
    await expect(page.locator("#mastery-goal")).toHaveValue(fresh.masteryGoal);
    await expect(page.locator("#beauty-trend")).toHaveValue(fresh.beautyTrend);
    await expect(page.locator("#research-time")).toHaveValue(fresh.researchTime);
    await expect(page.getByLabel("Skincare consistency")).toBeChecked();
    await expect(page.getByLabel("Quality over price")).toBeChecked();
    await expect(page.getByLabel("Professional results")).toBeChecked();
  } finally {
    releaseDelete();
    releaseMarkerRead();
  }
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

test("layout logout removes only the browser draft, not the online draft, and keeps it private from the next member", async ({ page }) => {
  const online = new Map<string, Answers>([["member-a", fixture("logout")]]);
  let deletions = 0;
  await page.route("**/api/users/me/radiant-audit**", route => {
    const request = route.request();
    const account = request.headers().authorization?.replace("Bearer ", "") ?? "";
    if (request.url().endsWith("/draft")) {
      if (request.method() === "DELETE") deletions++;
      return route.fulfill({ json: online.has(account)
        ? { ...online.get(account)!, updatedAt: new Date().toISOString() } : null });
    }
    return route.fulfill({ json: request.url().endsWith("/history") ? [] : null });
  });

  await signInAs(page, "member-a");
  await page.goto("/tests/audit-harness.html?page=/radiant-audit/complete");
  await page.evaluate(({ key, answers }) => localStorage.setItem(key, JSON.stringify({
    owner: "member-a", expiresAt: Date.now() + 86_400_000,
    onlineSynced: true,
    answers: { ...answers, email: "member-a@example.invalid" },
  })), { key: signedInDraftKey, answers: fixture("logout") });
  await page.goto("/tests/audit-harness.html?page=/layout");
  await page.getByRole("button", { name: "Log out" }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(deletions).toBe(0);
  expect(online.has("member-a")).toBe(true);

  await page.evaluate(() => localStorage.setItem("audit-test-account", "member-b"));
  await page.goto("/tests/audit-harness.html");
  await expect(page.locator("#beauty-trend")).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("logout private trend");
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(online.has("member-a")).toBe(true);
});

test("switching accounts on the Audit form clears the signed-in local draft without deleting the online draft", async ({ page }) => {
  let deletions = 0;
  await page.route("**/api/users/me/radiant-audit/draft", route => {
    if (route.request().method() === "DELETE") deletions++;
    if (route.request().method() === "GET") return route.fulfill({ json: null });
    return route.fulfill({ json: { ...route.request().postDataJSON(), updatedAt: new Date().toISOString() } });
  });
  await page.route("**/api/users/me/radiant-audit", route => route.fulfill({ json: null }));
  await signInAs(page, "member-a");
  await page.evaluate(() => localStorage.setItem("audit-test-verified", "false"));
  await page.reload();
  await page.locator("#beauty-trend").fill("private switching answer");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, signedInDraftKey)).toBe(true);
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("not been saved online");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("audit-test-account"))).toBeNull();
  expect(deletions).toBe(0);
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
      return route.fulfill({ json: { audit, completionKind: "first_time" } });
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

for (const scenario of ["expired", "far-future expiry", "unreadable JSON", "invalid answers"] as const) {
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
      if (scenario === "far-future expiry") record.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
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

test("returning to the dashboard clears invalid local Audit answers but preserves a current owner's draft", async ({ page }) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dashboard/stats") {
      return route.fulfill({ json: { totalCourses: 0, totalLessons: 0, totalEnrollments: 0, totalCategories: 0 } });
    }
    if (path === "/api/users/me") return route.fulfill({ json: { membershipTier: "Free" } });
    if (path.endsWith("/radiant-audit/draft") || path.endsWith("/radiant-audit") ||
        path === "/api/users/me/beauty-method") return route.fulfill({ contentType: "application/json", body: "null" });
    return route.fulfill({ json: [] });
  });
  await page.goto("/tests/audit-harness.html?page=/dashboard");
  await page.evaluate(() => localStorage.setItem("audit-test-account", "member-a"));

  const current = {
    owner: "member-a",
    expiresAt: Date.now() + 60_000,
    answers: { ...fixture("returning"), email: "member-a@example.invalid" },
  };
  const cases = [
    { name: "expired", raw: JSON.stringify({ ...current, expiresAt: Date.now() - 1 }) },
    { name: "far-future", raw: JSON.stringify({ ...current, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }) },
    { name: "malformed JSON", raw: '{"owner":"member-a","answers":' },
    { name: "invalid answers", raw: JSON.stringify({ ...current, answers: { ...current.answers, valuesChecks: "invalid" } }) },
  ];
  for (const { name, raw } of cases) {
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: signedInDraftKey, raw });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey), name).toBeNull();
  }

  const validRaw = JSON.stringify(current);
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: signedInDraftKey, raw: validRaw });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), signedInDraftKey)).toBe(validRaw);
  await page.goto("/tests/audit-harness.html");
  await expect(page.locator("#mastery-goal")).toHaveValue(current.answers.masteryGoal);
});

test("two devices choose which unfinished Audit draft to keep", async ({ page, browser }) => {
  let online: (Answers & { updatedAt: string }) | null = null;
  let sequence = 0;
  let failNextResolution = false;
  const handler = async (route: import("@playwright/test").Route) => {
    const req = route.request();
    if (new URL(req.url()).pathname.endsWith("/draft")) {
      if (req.method() === "GET") return route.fulfill({ json: online });
      if (req.headers()["x-audit-draft-revision"] !== (online?.updatedAt ?? "none"))
        return route.fulfill({ status: 409, json: { error: "Draft changed" } });
      if (req.method() === "PUT") {
        if (failNextResolution) {
          failNextResolution = false;
          return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
        }
        online = { ...(req.postDataJSON() as Answers), updatedAt: new Date(2026, 0, 1, 0, 0, sequence++).toISOString() };
        return route.fulfill({ json: online });
      }
      online = null;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: null });
  };
  await page.route("**/api/users/me/radiant-audit**", handler);
  await captureAuditTracking(page);
  const secondContext = await browser.newContext({ baseURL: "http://127.0.0.1:4179" });
  try {
    const second = await secondContext.newPage();
    await captureAuditTracking(second);
    await second.route("**/api/users/me/radiant-audit**", handler);
    await signInAs(page, "member-a");
    await signInAs(second, "member-a");
    await page.locator("#beauty-trend").fill("first device");
    await expect.poll(() => online?.beautyTrend).toBe("first device");
    await second.locator("#beauty-trend").fill("second device");
    await expect(second.getByRole("heading", { name: "Your Audit draft changed on another device" })).toBeVisible();
    expect(online?.beautyTrend).toBe("first device");
    failNextResolution = true;
    await second.getByRole("button", { name: "Keep this device's answers" }).click();
    await expect(second.getByText("Your choice couldn't be saved online. Try again.")).toBeVisible();
    expect(await auditConflictEvents(second)).toEqual([
      { name: "radiant_audit_draft_conflict_displayed", data: undefined },
    ]);
    await second.getByRole("button", { name: "Keep this device's answers" }).click();
    await expect.poll(() => online?.beautyTrend).toBe("second device");
    await expect(second.getByRole("heading", { name: "Your Audit draft changed on another device" })).toHaveCount(0);
    expect(await auditConflictEvents(second)).toEqual([
      { name: "radiant_audit_draft_conflict_displayed", data: undefined },
      { name: "radiant_audit_draft_conflict_resolved", data: { choice: "local" } },
    ]);
    await page.locator("#beauty-trend").fill("first device revised");
    await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toBeVisible();
    await page.getByRole("button", { name: "Use the other device's answers" }).click();
    await expect(page.locator("#beauty-trend")).toHaveValue("second device");
    expect(online?.beautyTrend).toBe("second device");
    expect(await auditConflictEvents(page)).toEqual([
      { name: "radiant_audit_draft_conflict_displayed", data: undefined },
      { name: "radiant_audit_draft_conflict_resolved", data: { choice: "online" } },
    ]);
  } finally {
    await secondContext.close();
  }
});

test("an idle form notices online edits and deletion on visibility without replacing local answers", async ({ page }) => {
  await captureAuditTracking(page);
  let online: (Answers & { updatedAt: string }) | { discardedAt: string } | null = null;
  let sequence = 0;
  const revision = () => online
    ? ("discardedAt" in online ? online.discardedAt : online.updatedAt) : "none";
  await page.route("**/api/users/me/radiant-audit**", route => {
    const req = route.request();
    if (!req.url().endsWith("/draft")) return route.fulfill({ json: null });
    if (req.method() === "GET") return route.fulfill({ json: online });
    if (req.headers()["x-audit-draft-revision"] !== revision())
      return route.fulfill({ status: 409, json: { error: "Draft changed" } });
    if (req.method() === "PUT") {
      online = { ...(req.postDataJSON() as Answers), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString() };
      return route.fulfill({ json: online });
    }
    online = { discardedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString() };
    return route.fulfill({ status: 204 });
  });
  await signInAs(page, "member-a");
  await page.locator("#beauty-trend").fill("unsaved local answer");
  await expect.poll(() => online && "beautyTrend" in online ? online.beautyTrend : null).toBe("unsaved local answer");
  online = { ...fixture("other device"), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString() };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toBeVisible();
  await expect(page.locator("#beauty-trend")).toHaveValue("unsaved local answer");
  await expect(page.getByText("other device private trend")).toBeVisible();
  await page.getByRole("button", { name: "Use the other device's answers" }).click();
  await expect(page.locator("#beauty-trend")).toHaveValue("other device private trend");
  expect(await auditConflictEvents(page)).toEqual([
    { name: "radiant_audit_draft_conflict_displayed", data: undefined },
    { name: "radiant_audit_draft_conflict_resolved", data: { choice: "online" } },
  ]);

  // No local edit is needed to discover the deletion marker either.
  online = { discardedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString() };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("The online draft was discarded on another device.", { exact: false })).toBeVisible();
  await expect(page.locator("#beauty-trend")).toHaveValue("other device private trend");
  await page.getByRole("button", { name: "Keep this device's answers" }).click();
  await expect.poll(() => online && "beautyTrend" in online ? online.beautyTrend : null).toBe("other device private trend");
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toHaveCount(0);
  expect(await auditConflictEvents(page)).toEqual([
    { name: "radiant_audit_draft_conflict_displayed", data: undefined },
    { name: "radiant_audit_draft_conflict_resolved", data: { choice: "online" } },
    { name: "radiant_audit_draft_conflict_displayed", data: undefined },
    { name: "radiant_audit_draft_conflict_resolved", data: { choice: "local" } },
  ]);
});

test("keeping an online deletion records a discard choice without sending answers", async ({ page }) => {
  await captureAuditTracking(page);
  await page.route("**/api/users/me/radiant-audit**", route => {
    if (!route.request().url().endsWith("/draft")) return route.fulfill({ json: null });
    if (route.request().method() === "GET")
      return route.fulfill({ json: { discardedAt: "2026-01-01T00:00:01.000Z" } });
    return route.fulfill({ status: 409, json: { error: "Draft changed" } });
  });
  await signInAs(page, "member-a");
  await page.locator("#beauty-trend").fill("private answer");
  await expect(page.getByRole("button", { name: "Keep the online draft discarded" })).toBeVisible();
  await page.getByRole("button", { name: "Keep the online draft discarded" }).click();
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toHaveCount(0);
  expect(await auditConflictEvents(page)).toEqual([
    { name: "radiant_audit_draft_conflict_displayed", data: undefined },
    { name: "radiant_audit_draft_conflict_resolved", data: { choice: "discard" } },
  ]);
});

test("the bounded idle check stays scoped to the signed-in account", async ({ page }) => {
  await page.clock.install();
  const online = new Map<string, Answers & { updatedAt: string }>();
  const reads: string[] = [];
  await page.route("**/api/users/me/radiant-audit**", route => {
    const req = route.request();
    const account = req.headers().authorization?.replace("Bearer ", "") ?? "";
    if (!req.url().endsWith("/draft")) return route.fulfill({ json: null });
    if (req.method() === "GET") {
      reads.push(account);
      return route.fulfill({ json: online.get(account) ?? null });
    }
    return route.fulfill({ json: { ...req.postDataJSON(), updatedAt: "2026-01-01T00:00:00.000Z" } });
  });
  await signInAs(page, "member-a");
  await expect(page.locator("#beauty-trend")).toBeVisible();
  online.set("member-a", { ...fixture("other device"), updatedAt: "2026-01-01T00:00:01.000Z" });
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toBeVisible();
  await expect(page.locator("#beauty-trend")).toHaveValue("");

  await signInAs(page, "member-b");
  await expect(page.locator("#beauty-trend")).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toHaveCount(0);
  const aReads = reads.filter(account => account === "member-a").length;
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads.filter(account => account === "member-b").length).toBeGreaterThanOrEqual(2);
  expect(reads.filter(account => account === "member-a").length).toBe(aReads);

  await page.evaluate(() => localStorage.setItem("audit-test-verified", "false"));
  await page.reload();
  await page.getByRole("button", { name: "Use another account" }).click();
  expect(await page.evaluate(() => localStorage.getItem("audit-test-account"))).toBeNull();
  await page.reload();
  const readCount = reads.length;
  await page.clock.fastForward(30_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(reads.length).toBe(readCount);
  await expect(page.getByRole("heading", { name: "Your Audit draft changed on another device" })).toHaveCount(0);
});

test("a completed Audit conflict cannot be dismissed as a draft choice", async ({ page }) => {
  await page.route("**/api/users/me/radiant-audit**", async route => {
    const req = route.request();
    if (req.url().endsWith("/draft")) {
      if (req.method() === "GET") return route.fulfill({ json: null });
      if (req.method() === "PUT") return route.fulfill({
        status: 409,
        json: { code: "completed_audit_changed", error: "The completed Audit changed" },
      });
    }
    return route.fulfill({ json: null });
  });
  await signInAs(page, "member-a");
  await page.locator("#beauty-trend").fill("unsaved form");
  await expect(page.getByRole("heading", { name: "Your completed Audit changed on another device" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use the other device's answers" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Reload and review Audit" })).toBeVisible();
});

async function captureAuditTracking(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking = [];
    (window as unknown as { umami: { track: (name: string, data?: unknown) => void } }).umami = {
      track: (name, data) => {
        (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking.push({ name, data });
      },
    };
  });
}

async function auditConflictEvents(page: Page): Promise<TrackingEvent[]> {
  return page.evaluate(() =>
    (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking
      .filter(event => event.name.startsWith("radiant_audit_draft_conflict")),
  );
}

async function auditTracking(page: Page): Promise<TrackingEvent[]> {
  return page.evaluate(() => (window as unknown as { __auditTracking: TrackingEvent[] }).__auditTracking);
}
