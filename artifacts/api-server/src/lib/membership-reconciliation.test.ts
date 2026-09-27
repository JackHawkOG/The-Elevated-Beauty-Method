import { expect, test } from "vitest";
import type Stripe from "stripe";
import type { PoolClient } from "@workspace/db";
import { failedBillingMonths, isSubscriptionEnded, reconcileSubscription } from "./membership-reconciliation";

const time = (date: string) => Date.parse(date) / 1000;
function invoice(id: string, date: string, status: Stripe.Invoice.Status, reason: Stripe.Invoice.BillingReason = "subscription_cycle"): Stripe.Invoice {
  return { id, created: time(date), status, billing_reason: reason, attempt_count: 1 } as Stripe.Invoice;
}

test("counts each failed renewal month once and stops at the latest successful renewal", () => {
  expect(failedBillingMonths([
    invoice("old", "2026-01-01", "open"),
    invoice("paid", "2026-02-01", "paid"),
    invoice("march", "2026-03-01", "open"),
    invoice("march-retry", "2026-03-11", "open"),
    invoice("april", "2026-04-01", "uncollectible"),
    invoice("setup", "2026-05-01", "open", "subscription_create"),
  ])).toEqual({ count: 2, lastId: "april" });
  expect(failedBillingMonths([invoice("failed", "2026-04-01", "open"), invoice("paid", "2026-05-01", "paid")]))
    .toEqual({ count: 0, lastId: null });
});

test("scheduled cancellation preserves access through the end date", () => {
  const sub = { status: "active", cancel_at: time("2026-04-01"), cancel_at_period_end: true } as Stripe.Subscription;
  expect(isSubscriptionEnded(sub, Date.parse("2026-03-31"))).toBe(false);
  expect(isSubscriptionEnded(sub, Date.parse("2026-04-01"))).toBe(true);
  expect(isSubscriptionEnded({ ...sub, status: "canceled" }, Date.parse("2026-03-31"))).toBe(true);
});

test("a third distinct failed month cancels once; a later event never restores forfeited status", async () => {
  let status = "confirmed";
  let cancellations = 0;
  let tier = "Elevated";
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT id, clerk_id")) {
        return { rows: [{ id: "1", clerk_id: "member", kind: "founding", status }] };
      }
      if (sql.startsWith("UPDATE membership_checkouts SET status")) status = "forfeited";
      if (sql.startsWith("UPDATE users SET membership_tier = 'Free'")) tier = "Free";
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const stripe = {
    subscriptions: {
      retrieve: async () => ({ status: "active", cancel_at: null, cancel_at_period_end: false }),
      cancel: async () => { cancellations++; return { status: "canceled", cancel_at: null }; },
    },
    invoices: {
      list: async () => ({
        data: [invoice("3", "2026-03-01", "open"), invoice("2", "2026-02-01", "open"), invoice("1", "2026-01-01", "open")],
        has_more: false,
      }),
    },
  } as unknown as Stripe;
  await reconcileSubscription(client, "sub_1", stripe);
  await reconcileSubscription(client, "sub_1", stripe);
  expect(cancellations).toBe(1);
  expect(status).toBe("forfeited");
  expect(tier).toBe("Free");
  expect(queries.filter(sql => sql.startsWith("UPDATE membership_checkouts"))).toHaveLength(1);
});