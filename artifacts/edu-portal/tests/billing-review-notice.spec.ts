import { expect, test, type Page } from "@playwright/test";

const owner = "billing-notice-owner";
const notice = { id: "opaque-private-notice", createdAt: "2026-10-01T14:00:00Z" };

async function fixture(page: Page) {
  let recovered = false;
  const billingRequests: string[] = [];
  const unexpectedRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(({ owner }) => {
    localStorage.setItem("audit-test-account", owner);
    localStorage.setItem(`audit-test-role:${owner}`, "owner");
  }, { owner });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  // Fail closed: every API read is controlled and every unexpected request
  // (especially writes, checkout, or membership-page reads) is rejected.
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${path}`);
      return route.abort();
    }
    if (path === "/api/membership/review-notifications") {
      billingRequests.push(request.headers().authorization ?? "");
      return route.fulfill({ json: recovered ? [] : [notice] });
    }
    const responses: Record<string, unknown> = {
      "/api/member-stories/removal-alerts": [],
      "/api/users/me": { id: 1, membershipTier: "Free" },
      "/api/users/me/beauty-method": null,
      "/api/users/me/radiant-audit": null,
      "/api/dashboard/stats": { totalCourses: 0, totalLessons: 0, totalEnrollments: 0, totalCategories: 0 },
      "/api/dashboard/featured": [],
      "/api/dashboard/recent-activity": [],
      "/api/enrollments": [],
    };
    if (!(path in responses)) {
      unexpectedRequests.push(`${request.method()} ${path}`);
      return route.abort();
    }
    return route.fulfill({ json: responses[path] });
  });
  await page.clock.install();
  await page.goto("/tests/billing-notice-harness.html");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  const banner = page.getByRole("status").filter({ hasText: "Billing review needs attention:" });
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText("one founding subscription has repeatedly failed automatic review");
  await expect(banner.getByRole("link", { name: "Review membership alerts" })).toHaveAttribute("href", "/membership");
  await expect(page.getByTestId("current-location")).toHaveText("/dashboard");
  await expect(page.locator("body")).not.toContainText(notice.id);
  await expect(page.locator("body")).not.toContainText(notice.createdAt);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  return {
    banner, billingRequests,
    recover: () => { recovered = true; },
    assertIsolated: () => {
      expect(unexpectedRequests).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(billingRequests.every(identity => identity === `Bearer ${owner}`)).toBe(true);
    },
  };
}

async function focusRefresh(page: Page) {
  // React Query listens to visibilitychange. Explicit events are deterministic
  // in headless Chromium, where bringToFront need not emit a focus event.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  // React Query schedules its focus notification on a timeout.
  await page.clock.runFor(1);
}

for (const recovery of ["focus", "interval"] as const) {
  test(`dashboard notice stays singular during polling and clears after ${recovery} recovery`, async ({ page }) => {
    const f = await fixture(page);
    for (let i = 0; i < 3; i++) {
      const before = f.billingRequests.length;
      await page.clock.runFor(30_000);
      await expect.poll(() => f.billingRequests.length).toBeGreaterThan(before);
      await page.waitForTimeout(50);
      await page.clock.runFor(1);
      await expect(page.getByTestId("billing-fetching")).toHaveText("0");
      await expect(f.banner).toHaveCount(1);
    }
    f.recover();
    const before = f.billingRequests.length;
    if (recovery === "focus") await focusRefresh(page);
    else await page.clock.runFor(30_000);
    await expect.poll(() => f.billingRequests.length).toBeGreaterThan(before);
    await expect(f.banner).toHaveCount(0);
    await expect(page.getByTestId("current-location")).toHaveText("/dashboard");
    f.assertIsolated();
  });
}

test("owner-to-member switch hides retained notices and never polls the owner endpoint as a member", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "Switch to member" }).click();
  await expect(f.banner).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Member stories", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect owner cache" }).click();
  await expect(page.getByTestId("owner-cache")).toHaveText("1");
  const afterSwitch = f.billingRequests.length;
  await focusRefresh(page);
  await page.clock.runFor(90_000);
  // Let async fetch continuations settle without introducing a page reload.
  await page.waitForTimeout(200);
  expect(f.billingRequests).toHaveLength(afterSwitch);
  await expect(f.banner).toHaveCount(0);
  await expect(page.getByTestId("current-location")).toHaveText("/dashboard");
  f.assertIsolated();
});