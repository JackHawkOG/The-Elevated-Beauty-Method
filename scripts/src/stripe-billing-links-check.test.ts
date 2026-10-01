import { beforeEach, expect, it, vi } from "vitest";
import { checkStripeBillingLinks } from "./stripe-billing-links-check";
import { getTestStripeClient } from "./stripeClient";
import { stripeBillingPortalUrl } from "../../artifacts/edu-portal/src/lib/stripe-billing-portal-url";

vi.mock("./stripeClient", () => ({ getTestStripeClient: vi.fn() }));
const url = "https://billing.stripe.com/p/session/test_secret?locale=en";
const stripe = {
  customers: {
    create: vi.fn(), del: vi.fn(),
  },
  billingPortal: {
    configurations: { list: vi.fn() },
    sessions: { create: vi.fn() },
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getTestStripeClient).mockResolvedValue(stripe as unknown as Awaited<ReturnType<typeof getTestStripeClient>>);
  stripe.customers.create.mockResolvedValue({ id: "cus_fixture", livemode: false });
  stripe.customers.del.mockResolvedValue({});
  stripe.billingPortal.configurations.list.mockResolvedValue({ data: [{
    id: "bpc_fixture", livemode: false,
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      payment_method_update: { enabled: true }, subscription_update: { enabled: false },
    },
  }] });
  stripe.billingPortal.sessions.create.mockResolvedValue({ url });
});

it("checks the real session response with the same validator and cleans up only its own fixtures", async () => {
  await expect(checkStripeBillingLinks()).resolves.toBeUndefined();
  expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
    customer: "cus_fixture", configuration: "bpc_fixture", return_url: "https://example.invalid/membership",
  });
  expect(stripe.customers.create.mock.calls[0][0]).not.toHaveProperty("email");
  expect(stripe.customers.del).toHaveBeenCalledWith("cus_fixture");
  expect(stripeBillingPortalUrl(url)).toBe(url);
});

it.each([
  "http://billing.stripe.com/p/session/test",
  "https://billing.stripe.com.evil.example/p/session/test",
  "https://user@billing.stripe.com/p/session/test",
  "https://billing.stripe.com:444/p/session/test",
  "https://billing.stripe.com/other/test",
  "https://billing.stripe.com/p/session/",
  "https://billing.stripe.com/p/session",
  "https://billing.stripe.com/p/session/test/extra",
  `${url}\njavascript:alert(1)`,
  ` ${url}`,
  null,
])("fails clearly for an untrusted or changed URL without printing it (%#)", async value => {
  stripe.billingPortal.sessions.create.mockResolvedValue({ url: value });
  const error = await checkStripeBillingLinks().then(() => { throw new Error("Expected failure"); }, error => error as Error);
  expect(error.message).toContain("Stripe's URL format may have changed");
  expect(error.message).not.toContain("https://");
  expect(stripe.customers.del).toHaveBeenCalledOnce();
});

it("refuses non-test credentials before any fixture is created", async () => {
  vi.mocked(getTestStripeClient).mockRejectedValue(new Error("Membership fixtures require Stripe test mode."));
  await expect(checkStripeBillingLinks()).rejects.toThrow("require Stripe test mode");
  expect(stripe.customers.create).not.toHaveBeenCalled();
  expect(stripe.billingPortal.configurations.list).not.toHaveBeenCalled();
});

it("cleans up the customer if session creation fails and redacts provider details", async () => {
  stripe.billingPortal.sessions.create.mockRejectedValue(new Error(url));
  await expect(checkStripeBillingLinks()).rejects.toThrow("obtaining a real test-mode portal session");
  expect(stripe.customers.del).toHaveBeenCalledOnce();
});

it("fails without creating fixtures or changing shared settings when configuration is missing", async () => {
  stripe.billingPortal.configurations.list.mockResolvedValue({ data: [] });
  await expect(checkStripeBillingLinks()).rejects.toThrow("Prerequisite missing");
  expect(stripe.customers.create).not.toHaveBeenCalled();
  expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
});

it("reports cleanup failure even after a passing URL check without leaking provider details", async () => {
  stripe.customers.del.mockRejectedValue(new Error(url));
  const error = await checkStripeBillingLinks().then(() => { throw new Error("Expected failure"); }, error => error as Error);
  expect(error.message).toContain("Could not delete");
  expect(error.message).not.toContain(url);
});