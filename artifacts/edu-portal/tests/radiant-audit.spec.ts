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