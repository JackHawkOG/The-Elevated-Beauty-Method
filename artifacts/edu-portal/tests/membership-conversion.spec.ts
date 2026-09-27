import { expect, test } from "@playwright/test";

type Kind = "founding" | "standard";
type Event = { name: string; data?: Record<string, string> };

for (const kind of ["founding", "standard"] as const) {
  test(`${kind} checkout counts enrollment only after server confirmation, once across refresh`, async ({ page }) => {
    const events: Event[] = [];
    let status: "pending" | "confirmed" = "pending";
    let membership: { kind: Kind; status: "pending" | "confirmed" } | null = null;
    const checkoutUrl = `https://checkout.stripe.test/session/${kind}`;

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
    await page.route("https://checkout.stripe.test/**", route => route.fulfill({
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