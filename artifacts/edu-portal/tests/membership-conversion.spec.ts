import { expect, test } from "@playwright/test";

type Kind = "founding" | "standard";
type Event = { name: string; data?: Record<string, string> };

for (const kind of ["founding", "standard"] as const) {
  test(`${kind} existing membership ignores a stale success link`, async ({ page }) => {
    const events: Event[] = [];
    let checkoutRequests = 0;
    await page.exposeBinding("__recordMembershipEvent", (_source, event: Event) => {
      events.push(event);
    });
    await page.addInitScript(() => {
      localStorage.setItem("audit-test-account", "membership-test-member");
      (window as unknown as { umami: { track: (name: string, data?: Record<string, string>) => void } }).umami = {
        track: (name, data) => {
          void (window as unknown as { __recordMembershipEvent: (event: Event) => Promise<void> })
            .__recordMembershipEvent({ name, data });
        },
      };
    });
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({
      json: { membership: { kind, status: "confirmed" } },
    }));
    await page.route("**/api/membership/checkout", route => {
      checkoutRequests++;
      return route.fulfill({ json: { url: `https://checkout.stripe.com/session/${kind}` } });
    });

    await page.goto("/tests/membership-harness.html?checkout=success");
    await expect(page.getByText(/membership is active/)).toBeVisible();
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);
    expect(checkoutRequests).toBe(0);
    expect(events).toEqual([]);

    await page.goto("/tests/membership-harness.html?checkout=success");
    await expect(page.getByText(/membership is active/)).toBeVisible();
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);
    expect(events).toEqual([]);
  });

}

for (const { kind, failure } of [
  { kind: "founding", failure: "server error" },
  { kind: "standard", failure: "missing redirect URL" },
] as const) {
  test(`${kind} checkout ${failure} stays on membership without conversion events`, async ({ page }) => {
    const events: Event[] = [];
    let checkoutRequests = 0;
    await page.exposeBinding("__recordMembershipEvent", (_source, event: Event) => {
      events.push(event);
    });
    await page.addInitScript(() => {
      localStorage.setItem("audit-test-account", "membership-test-member");
      (window as unknown as { umami: { track: (name: string, data?: Record<string, string>) => void } }).umami = {
        track: (name, data) => {
          void (window as unknown as { __recordMembershipEvent: (event: Event) => Promise<void> })
            .__recordMembershipEvent({ name, data });
        },
      };
    });
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({ json: { membership: null } }));
    await page.route("**/api/membership/checkout", route => {
      checkoutRequests++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ kind });
      return failure === "server error"
        ? route.fulfill({ status: 503, json: { message: "Checkout could not be started. Please try again." } })
        : route.fulfill({ json: {} });
    });

    await page.goto("/tests/membership-harness.html");
    await page.getByRole("button", { name: kind === "founding" ? "Continue to secure checkout" : "Join at the standard rate" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Checkout could not be started. Please try again." })).toBeVisible();
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);
    expect(checkoutRequests).toBe(1);
    expect(events).toEqual([]);
  });
}

for (const url of [
  "",
  "not a URL",
  "/membership",
  "javascript:alert('bad')",
  "http://checkout.stripe.com/session/test_123",
  "https://checkout.stripe.com.evil.example/session/test_123",
  "https://evil.example/session/test_123",
  "https://user@checkout.stripe.com/session/test_123",
  "https://checkout.stripe.com:444/session/test_123",
  "https://checkout.stripe.com/session/test_123\njavascript:alert(1)",
]) {
  test(`invalid checkout destination ${JSON.stringify(url)} stays on membership`, async ({ page }) => {
    const events: Event[] = [];
    await page.exposeBinding("__recordMembershipEvent", (_source, event: Event) => {
      events.push(event);
    });
    await page.addInitScript(() => {
      localStorage.setItem("audit-test-account", "membership-test-member");
      (window as unknown as { umami: { track: (name: string, data?: Record<string, string>) => void } }).umami = {
        track: (name, data) => {
          void (window as unknown as { __recordMembershipEvent: (event: Event) => Promise<void> })
            .__recordMembershipEvent({ name, data });
        },
      };
    });
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({ json: { membership: null } }));
    await page.route("**/api/membership/checkout", route => route.fulfill({ json: { url } }));

    await page.goto("/tests/membership-harness.html");
    await page.getByRole("button", { name: "Continue to secure checkout" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Checkout could not be started. Please try again." })).toBeVisible();
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);
    expect(events).toEqual([]);
  });
}

for (const url of [
  undefined,
  "",
  "not a URL",
  "/membership",
  "javascript:alert('bad')",
  "http://billing.stripe.com/p/session/test_123",
  "https://billing.stripe.com.evil.example/p/session/test_123",
  "https://evil.example/p/session/test_123",
  "https://user@billing.stripe.com/p/session/test_123",
  "https://billing.stripe.com:444/p/session/test_123",
  "https://billing.stripe.com/other",
  "https://billing.stripe.com/p/session/",
  "https://billing.stripe.com/p/session/test_123\njavascript:alert(1)",
]) {
  test(`invalid billing portal destination ${JSON.stringify(url)} stays on membership`, async ({ page }) => {
    let portalRequests = 0;
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({
      json: { membership: { kind: "standard", status: "confirmed" } },
    }));
    await page.route("**/api/membership/portal", route => {
      portalRequests++;
      expect(route.request().method()).toBe("POST");
      return route.fulfill({ json: url === undefined ? {} : { url } });
    });

    await page.goto("/tests/membership-harness.html");
    await page.getByRole("button", { name: "Manage billing or cancel" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Billing is temporarily unavailable. Please try again." })).toBeVisible();
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);
    expect(portalRequests).toBe(1);
  });
}

test("valid Stripe billing portal session opens from membership", async ({ page }) => {
  const portalUrl = "https://billing.stripe.com/p/session/test_123?prefilled_email=member%40example.com";
  await page.route("**/api/membership/offer", route => route.fulfill({
    json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
  }));
  await page.route("**/api/membership/me", route => route.fulfill({
    json: { membership: { kind: "standard", status: "confirmed" } },
  }));
  await page.route("**/api/membership/portal", route => route.fulfill({ json: { url: portalUrl } }));
  await page.route("https://billing.stripe.com/**", route => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>Stripe billing portal test</title>",
  }));

  await page.goto("/tests/membership-harness.html");
  await page.getByRole("button", { name: "Manage billing or cancel" }).click();
  await expect(page).toHaveURL(portalUrl);
});

for (const kind of ["founding", "standard"] as const) {
  test(`${kind} cancelled checkout stays pending without a paid conversion and can be continued`, async ({ page }) => {
    const events: Event[] = [];
    let checkoutRequests = 0;
    let membership: { kind: Kind; status: "pending" | "confirmed" } | null = null;
    const checkoutUrl = `https://checkout.stripe.com/session/${kind}`;

    await page.exposeBinding("__recordMembershipEvent", (_source, event: Event) => {
      events.push(event);
    });
    await page.addInitScript(() => {
      localStorage.setItem("audit-test-account", "membership-test-member");
      (window as unknown as { umami: { track: (name: string, data?: Record<string, string>) => void } }).umami = {
        track: (name, data) => {
          void (window as unknown as { __recordMembershipEvent: (event: Event) => Promise<void> })
            .__recordMembershipEvent({ name, data });
        },
      };
    });
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({
      json: { membership },
    }));
    await page.route("**/api/membership/checkout", async route => {
      checkoutRequests++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ kind });
      membership = { kind, status: "pending" };
      await route.fulfill({ json: { url: checkoutUrl } });
    });
    await page.route("https://checkout.stripe.com/**", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Stripe checkout test</title>",
    }));

    await page.goto("/tests/membership-harness.html");
    await page.getByRole("button", { name: kind === "founding" ? "Continue to secure checkout" : "Join at the standard rate" }).click();
    await expect(page).toHaveURL(checkoutUrl);
    await expect.poll(() => events).toEqual([
      { name: "membership_checkout_started", data: { kind } },
    ]);

    await page.goto("/tests/membership-harness.html?checkout=cancel");
    await expect(page.getByText("Your checkout is awaiting payment confirmation.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue checkout" })).toBeEnabled();
    await expect(page).toHaveURL(/checkout=cancel/);
    expect(events).toEqual([{ name: "membership_checkout_started", data: { kind } }]);

    await page.getByRole("button", { name: "Continue checkout" }).click();
    await expect(page).toHaveURL(checkoutUrl);
    await expect.poll(() => events).toEqual([
      { name: "membership_checkout_started", data: { kind } },
      { name: "membership_checkout_started", data: { kind } },
    ]);
    expect(checkoutRequests).toBe(2);
    expect(events.some(event => event.name === "membership_enrollment_confirmed")).toBe(false);
  });

  test(`${kind} checkout counts enrollment only after server confirmation, once across refresh`, async ({ page }) => {
    const events: Event[] = [];
    let status: "pending" | "confirmed" = "pending";
    let membership: { kind: Kind; status: "pending" | "confirmed" } | null = null;
    const checkoutUrl = `https://checkout.stripe.com/session/${kind}`;

    await page.exposeBinding("__recordMembershipEvent", (_source, event: Event) => {
      events.push(event);
    });
    await page.addInitScript(() => {
      localStorage.setItem("audit-test-account", "membership-test-member");
      (window as unknown as { umami: { track: (name: string, data?: Record<string, string>) => void } }).umami = {
        track: (name, data) => {
          void (window as unknown as { __recordMembershipEvent: (event: Event) => Promise<void> })
            .__recordMembershipEvent({ name, data });
        },
      };
    });
    await page.route("**/api/membership/offer", route => route.fulfill({
      json: { phase: "open", foundingAvailable: true, foundingPrice: 24, standardPrice: 48 },
    }));
    await page.route("**/api/membership/me", route => route.fulfill({
      json: { membership: membership && { ...membership, status } },
    }));
    await page.route("**/api/membership/checkout", async route => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ kind });
      membership = { kind, status: "pending" };
      await route.fulfill({ json: { url: checkoutUrl } });
    });
    await page.route("https://checkout.stripe.com/**", route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Stripe checkout test</title>",
    }));

    await page.goto("/tests/membership-harness.html");
    await page.getByRole("button", { name: kind === "founding" ? "Continue to secure checkout" : "Join at the standard rate" }).click();
    await expect(page).toHaveURL(checkoutUrl);
    await expect.poll(() => events).toEqual([
      { name: "membership_checkout_started", data: { kind } },
    ]);

    await page.goto("/tests/membership-harness.html?checkout=success");
    await expect(page.getByText("Your checkout is awaiting payment confirmation.")).toBeVisible();
    expect(events).toEqual([{ name: "membership_checkout_started", data: { kind } }]);
    await expect(page).toHaveURL(/checkout=success/);

    // The next membership poll observes the server-side webhook transition.
    status = "confirmed";
    await expect(page.getByText(/membership is active/)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => events).toEqual([
      { name: "membership_checkout_started", data: { kind } },
      { name: "membership_enrollment_confirmed", data: { kind } },
    ]);
    await expect(page).toHaveURL(/\/tests\/membership-harness\.html$/);

    await page.reload();
    await expect(page.getByText(/membership is active/)).toBeVisible();
    expect(events).toEqual([
      { name: "membership_checkout_started", data: { kind } },
      { name: "membership_enrollment_confirmed", data: { kind } },
    ]);
  });
}
