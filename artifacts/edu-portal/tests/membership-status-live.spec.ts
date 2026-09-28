import { randomBytes } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import { getTestStripeClient } from "../../../scripts/src/stripeClient";
import { membershipStatusFixtureMetadata } from "./membership-status-fixtures";

type MembershipResponse = {
  code: number;
  body: { membership?: { kind: string; status: string; cancellationDate: string | null }; error?: string };
};

async function status(page: Page): Promise<MembershipResponse> {
  return page.evaluate(async () => {
    const token = await (window as typeof window & {
      Clerk?: { session?: { getToken: () => Promise<string | null> } };
    }).Clerk?.session?.getToken();
    const response = await fetch("/api/membership/me", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
    return { code: response.status, body: await response.json() };
  });
}

test("real Clerk sessions reveal only their own scheduled membership cancellation", async ({ page }) => {
  test.setTimeout(120_000);
  requireAuditDevelopment();
  await clerkSetup();
  const stripe = await getTestStripeClient();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomBytes(6).toString("hex");
  const accounts = [
    { email: `membership-status-a-${tag}+clerk_test@example.com`, kind: "standard", days: 4 },
    { email: `membership-status-b-${tag}+clerk_test@example.com`, kind: "founding", days: 5 },
  ] as const;
  const ids: string[] = [];
  const subscriptionIds: string[] = [];
  const customerIds: string[] = [];
  let productId: string | undefined;
  let priceId: string | undefined;

  try {
    await setupClerkTestingToken({ page });
    // This free, test-mode price cannot charge a card or affect real billing.
    const product = await stripe.products.create({ name: `Disposable membership privacy check ${tag}` });
    productId = product.id;
    const price = await stripe.prices.create({
      product: product.id, currency: "usd", unit_amount: 0, recurring: { interval: "month" },
    });
    priceId = price.id;

    const { pool } = await import("../../../lib/db/src/index");
    const expected: string[] = [];
    for (const account of accounts) {
      const user = await client.users.createUser({
        emailAddress: [account.email], skipPasswordRequirement: true,
        privateMetadata: membershipStatusFixtureMetadata,
      });
      ids.push(user.id);
      const customer = await stripe.customers.create({ email: account.email });
      customerIds.push(customer.id);
      const subscription = await stripe.subscriptions.create({
        customer: customer.id, items: [{ price: price.id }],
      });
      subscriptionIds.push(subscription.id);
      const cancelAt = Math.floor(Date.now() / 1000) + account.days * 86400;
      const scheduled = await stripe.subscriptions.update(subscription.id, { cancel_at: cancelAt });
      expect(scheduled.cancel_at).toBe(cancelAt);
      expected.push(new Date(cancelAt * 1000).toISOString());

      // Provision the actual app user through the signed-in route; do not
      // substitute a header for Clerk identity as the route-level unit test does.
      await page.goto("/membership");
      await clerk.signIn({ page, emailAddress: account.email });
      await page.goto("/membership");
      expect((await status(page)).code).toBe(200);
      await pool.query(
        "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, $2, 'confirmed', $3)",
        [user.id, account.kind, subscription.id],
      );
      expect(await status(page)).toEqual({
        code: 200,
        body: { membership: { kind: account.kind, status: "confirmed", cancellationDate: expected[expected.length - 1] } },
      });
      await clerk.signOut({ page });
    }
    expect(expected[0]).not.toBe(expected[1]);

    for (const [index, account] of accounts.entries()) {
      await page.goto("/membership");
      await clerk.signIn({ page, emailAddress: account.email });
      await page.goto("/membership");
      const response = await status(page);
      expect(response).toEqual({
        code: 200,
        body: { membership: { kind: account.kind, status: "confirmed", cancellationDate: expected[index] } },
      });
      expect(JSON.stringify(response.body)).not.toContain(expected[1 - index]);
      await clerk.signOut({ page });
    }
    await page.goto("/");
    expect(await status(page)).toEqual({ code: 401, body: { error: "Unauthorized" } });
  } finally {
    requireAuditDevelopment();
    // Delete this run's rows before removing its identities. If DB cleanup
    // fails, keep the marked identities so the records remain attributable.
    const { pool } = await import("../../../lib/db/src/index");
    if (ids.length) {
      try {
        await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [ids]);
        await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [ids]);
      } catch (error) {
        throw new Error("Membership fixture database cleanup failed; marked identities retained.", { cause: error });
      }
    }
    // Try every remote cleanup even if one Stripe call fails.
    const results = await Promise.allSettled(subscriptionIds.map(id => stripe.subscriptions.cancel(id)));
    results.push(...await Promise.allSettled(customerIds.map(id => stripe.customers.del(id))));
    if (priceId) results.push((await Promise.allSettled([stripe.prices.update(priceId, { active: false })]))[0]);
    // Stripe retains prices for billing history and will not delete their product.
    if (productId) results.push((await Promise.allSettled([stripe.products.update(productId, { active: false })]))[0]);
    results.push(...await Promise.allSettled(ids.map(id => client.users.deleteUser(id))));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Membership fixture cleanup failed.");
  }
});