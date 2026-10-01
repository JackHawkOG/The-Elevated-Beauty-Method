import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { pool } from "@workspace/db";
import { ensureMembershipSchema } from "./ensure-membership-schema";
import { requireDevelopmentDatabase } from "../routes/test-development-database";

vi.mock("./stripeClient", () => ({
  getStripeSync: vi.fn(),
  getUncachableStripeClient: vi.fn(),
}));

import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { reconcileMemberships } from "./membership-reconciliation";
import { handleMembershipWebhook } from "../routes/membership";

const id = randomUUID();
const clerkId = `billing-race-${id}`;
const subscriptionId = `sub_billing_race_${id}`;
const otherClerkId = `billing-bystander-${id}`;
const otherSubscriptionId = `sub_billing_bystander_${id}`;
const paginatedClerkId = `billing-paginated-${id}`;
const paginatedSubscriptionId = `sub_billing_paginated_${id}`;
const paidDuringReviewClerkId = `billing-paid-during-review-${id}`;
const paidDuringReviewSubscriptionId = `sub_billing_paid_during_review_${id}`;
const eventIds: string[] = [];
let seeded = false;
function invoice(name: string, date: string, status: Stripe.Invoice.Status): Stripe.Invoice {
  return {
    id: `in_${name}_${id}`,
    created: Date.parse(date) / 1000,
    status,
    billing_reason: "subscription_cycle",
    attempt_count: 1,
  } as Stripe.Invoice;
}

type MembershipState = { status: string; failed_months: number; last_failed_invoice: string | null; membership_tier: string };
async function state(forSubscriptionId = subscriptionId): Promise<MembershipState> {
  const result = await pool.query<MembershipState>(
    "SELECT m.status, m.failed_months, m.last_failed_invoice, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_subscription_id = $1",
    [forSubscriptionId],
  );
  return result.rows[0];
}

async function deliver(type: string, object: object, eventId = `evt_${randomUUID()}`): Promise<number> {
  eventIds.push(eventId);
  const req = {
    headers: { "stripe-signature": "test-signature" },
    body: Buffer.from(JSON.stringify({ id: eventId, type, data: { object } })),
    log: { error: vi.fn() },
  } as unknown as Request;
  let code = 200;
  const res = {
    status(value: number) { code = value; return this; },
    json: vi.fn(),
  } as unknown as Response;
  await handleMembershipWebhook(req, res);
  expect(res.json).toHaveBeenCalledWith(code === 200 ? { received: true } : { error: "Webhook processing failed" });
  return code;
}

beforeAll(async () => {
  // Check before opening a connection or running even idempotent schema setup.
  requireDevelopmentDatabase();
  await ensureMembershipSchema();
  await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [clerkId, "Billing race fixture", `${clerkId}@example.invalid`]);
  seeded = true;
  await pool.query(
    "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
    [clerkId, subscriptionId],
  );
  await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [otherClerkId, "Billing bystander fixture", `${otherClerkId}@example.invalid`]);
  await pool.query(
    "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id, failed_months) VALUES ($1, 'founding', 'confirmed', $2, 2)",
    [otherClerkId, otherSubscriptionId],
  );
  await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [paginatedClerkId, "Paginated billing fixture", `${paginatedClerkId}@example.invalid`]);
  await pool.query(
    "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
    [paginatedClerkId, paginatedSubscriptionId],
  );
  await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [paidDuringReviewClerkId, "Paid during billing review fixture", `${paidDuringReviewClerkId}@example.invalid`]);
  await pool.query(
    "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
    [paidDuringReviewClerkId, paidDuringReviewSubscriptionId],
  );
});

afterAll(async () => {
  if (!seeded) return;
  await pool.query("DELETE FROM membership_webhook_events WHERE id = ANY($1::text[])", [eventIds]);
  await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId, paidDuringReviewClerkId]]);
  await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId, paidDuringReviewClerkId]]);
});

test("late invoice and subscription notices use current Stripe state; sweeps cannot undo forfeiture", async () => {
  let stripeStatus: Stripe.Subscription.Status = "active";
  let invoices = [
    invoice("feb", "2026-02-01", "open"),
    invoice("jan", "2026-01-01", "open"),
  ];
  let cancellations = 0;
  let retrievals = 0;
  let enteredRetrieve!: () => void;
  const retrieveEntered = new Promise<void>(resolve => { enteredRetrieve = resolve; });
  let releaseRetrieve!: () => void;
  const retrieveReleased = new Promise<void>(resolve => { releaseRetrieve = resolve; });
  const stripe = {
    subscriptions: {
      retrieve: async (requestedId: string) => {
        expect(requestedId).toBe(subscriptionId);
        retrievals++;
        if (retrievals === 1) {
          enteredRetrieve();
          await retrieveReleased;
        }
        return { status: stripeStatus, cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
      cancel: async (requestedId: string) => {
        expect(requestedId).toBe(subscriptionId);
        cancellations++;
        stripeStatus = "canceled";
        return { status: "canceled", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
    },
    invoices: { list: async () => ({ data: invoices, has_more: false }) },
  } as unknown as Stripe;
  vi.mocked(getStripeSync).mockResolvedValue({ processWebhook: vi.fn().mockResolvedValue(undefined) } as never);
  vi.mocked(getUncachableStripeClient).mockResolvedValue(stripe);

  const lateFailure = deliver("invoice.payment_failed", {
    object: "invoice",
    id: invoices[0].id,
    parent: { subscription_details: { subscription: subscriptionId } },
  });
  await retrieveEntered; // The first transaction has locked the checkout row.
  const newerSubscription = deliver("customer.subscription.updated", {
    object: "subscription", id: subscriptionId, status: "active",
  });
  // Stripe is authoritative, not either event's stale payload.
  invoices = [invoice("mar-paid", "2026-03-01", "paid"), ...invoices];
  releaseRetrieve();
  expect(await Promise.all([lateFailure, newerSubscription])).toEqual([200, 200]);
  expect(await state()).toEqual({
    status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
  });

  // A replayed delivery and two sweeps do not double-count failures.
  const replayId = eventIds[0];
  expect(await deliver("invoice.payment_failed", {
    object: "invoice", parent: { subscription_details: { subscription: subscriptionId } },
  }, replayId)).toBe(200);
  await reconcileMemberships(subscriptionId);
  await reconcileMemberships(subscriptionId);
  expect(await state()).toMatchObject({ status: "confirmed", failed_months: 0, membership_tier: "Elevated" });
  expect(cancellations).toBe(0);

  invoices = [
    invoice("jun", "2026-06-01", "open"),
    invoice("may", "2026-05-01", "open"),
    invoice("apr", "2026-04-01", "uncollectible"),
    ...invoices,
  ];
  expect(await Promise.all([
    deliver("invoice.payment_failed", {
      object: "invoice", parent: { subscription_details: { subscription: subscriptionId } },
    }),
    deliver("customer.subscription.updated", { object: "subscription", id: subscriptionId, status: "active" }),
  ])).toEqual([200, 200]);
  expect(await state()).toEqual({
    status: "forfeited", failed_months: 3, last_failed_invoice: invoices[0].id, membership_tier: "Free",
  });
  expect(cancellations).toBe(1);

  stripeStatus = "active";
  invoices = [invoice("jul-paid", "2026-07-01", "paid"), ...invoices];
  const before = retrievals;
  expect(await deliver("customer.subscription.updated", {
    object: "subscription", id: subscriptionId, status: "active",
  })).toBe(200);
  await reconcileMemberships(subscriptionId);
  await reconcileMemberships(subscriptionId);
  expect(retrievals).toBe(before); // Forfeited rows do not even query Stripe again.
  expect(cancellations).toBe(1);
  expect(await state()).toEqual({
    status: "forfeited", failed_months: 3,
    last_failed_invoice: `in_jun_${id}`, membership_tier: "Free",
  });
  const bystander = await pool.query<MembershipState>(
    "SELECT m.status, m.failed_months, m.last_failed_invoice, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_subscription_id = $1",
    [otherSubscriptionId],
  );
  expect(bystander.rows[0]).toEqual({
    status: "confirmed", failed_months: 2, last_failed_invoice: null, membership_tier: "Elevated",
  });
});

test("a renewal paid after invoice history is read keeps the founding place", async () => {
  const march = invoice("review-mar", "2026-03-01", "open");
  const february = invoice("review-feb", "2026-02-01", "open");
  const january = invoice("review-jan", "2026-01-01", "open");
  let invoices = [march, february, january];
  let firstRead!: () => void;
  const historyRead = new Promise<void>(resolve => { firstRead = resolve; });
  let resume!: () => void;
  const continueReview = new Promise<void>(resolve => { resume = resolve; });
  const list = vi.fn(async (params: { subscription: string; limit: number; starting_after?: string }) => {
    expect(params).toEqual({ subscription: paidDuringReviewSubscriptionId, limit: 100 });
    const snapshot = [...invoices];
    if (list.mock.calls.length === 1) {
      firstRead();
      await continueReview;
    }
    return { data: snapshot, has_more: false };
  });
  const cancel = vi.fn();
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: {
      retrieve: async (requestedId: string) => {
        expect(requestedId).toBe(paidDuringReviewSubscriptionId);
        return { status: "active", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
      cancel,
    },
    invoices: { list },
  } as unknown as Stripe);

  const reconciliation = reconcileMemberships(paidDuringReviewSubscriptionId);
  await historyRead;
  invoices = [{ ...march, status: "paid" }, february, january];
  resume();
  await reconciliation;

  expect(list).toHaveBeenCalledTimes(2);
  expect(cancel).not.toHaveBeenCalled();
  expect(await state(paidDuringReviewSubscriptionId)).toEqual({
    status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
  });
});

test("paid renewal on an older invoice page stops the failed-month streak", async () => {
  const marchFailure = invoice("paginated-mar", "2026-03-01", "open");
  const februaryFailure = invoice("paginated-feb", "2026-02-01", "uncollectible");
  const firstPage = [
    ...Array.from({ length: 98 }, (_, index) =>
      invoice(`paginated-draft-${index}`, "2026-03-03", "draft")),
    marchFailure,
    februaryFailure,
  ];
  const secondPage = [
    invoice("paginated-jan-paid", "2026-01-01", "paid"),
    invoice("paginated-dec", "2025-12-01", "open"),
  ];
  const list = vi.fn(async (params: { subscription: string; limit: number; starting_after?: string }) => {
    expect(params.subscription).toBe(paginatedSubscriptionId);
    expect(params.limit).toBe(100);
    if (params.starting_after === undefined) return { data: firstPage, has_more: true };
    if (params.starting_after === februaryFailure.id) return { data: secondPage, has_more: false };
    throw new Error(`Unexpected invoice cursor: ${params.starting_after}`);
  });
  const cancel = vi.fn();
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: {
      retrieve: async (requestedId: string) => {
        expect(requestedId).toBe(paginatedSubscriptionId);
        return { status: "active", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
      cancel,
    },
    invoices: { list },
  } as unknown as Stripe);

  await reconcileMemberships(paginatedSubscriptionId);

  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenNthCalledWith(2, {
    subscription: paginatedSubscriptionId, limit: 100, starting_after: februaryFailure.id,
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(await state(paginatedSubscriptionId)).toEqual({
    status: "confirmed", failed_months: 2, last_failed_invoice: marchFailure.id, membership_tier: "Elevated",
  });
});

test("a temporary Stripe retrieval failure rolls back the event so redelivery can end access once", async () => {
  const retryClerkId = `billing-retry-${id}`;
  const retrySubscriptionId = `sub_billing_retry_${id}`;
  const eventId = `evt_billing_retry_${id}`;
  const event = { object: "subscription", id: retrySubscriptionId, status: "canceled" };
  let retrievals = 0;
  const stripe = {
    subscriptions: {
      retrieve: async (requestedId: string) => {
        expect(requestedId).toBe(retrySubscriptionId);
        retrievals++;
        if (retrievals === 1) throw new Error("Temporary Stripe outage");
        return { status: "canceled", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
      cancel: vi.fn(),
    },
    invoices: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  } as unknown as Stripe;
  vi.mocked(getStripeSync).mockResolvedValue({ processWebhook: vi.fn().mockResolvedValue(undefined) } as never);
  vi.mocked(getUncachableStripeClient).mockResolvedValue(stripe);

  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [retryClerkId, "Billing retry fixture", `${retryClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
      [retryClerkId, retrySubscriptionId],
    );
    const retryState = async () => {
      const result = await pool.query<MembershipState>(
        "SELECT m.status, m.failed_months, m.last_failed_invoice, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_subscription_id = $1",
        [retrySubscriptionId],
      );
      return result.rows[0];
    };
    const recordedEvents = async () => {
      const result = await pool.query("SELECT id FROM membership_webhook_events WHERE id = $1", [eventId]);
      return result.rows;
    };

    expect(await deliver("customer.subscription.updated", event, eventId)).toBe(400);
    expect(await recordedEvents()).toEqual([]);
    expect(await retryState()).toEqual({
      status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
    });

    expect(await deliver("customer.subscription.updated", event, eventId)).toBe(200);
    expect(await recordedEvents()).toEqual([{ id: eventId }]);
    expect(await retryState()).toEqual({
      status: "forfeited", failed_months: 0, last_failed_invoice: null, membership_tier: "Free",
    });

    expect(await deliver("customer.subscription.updated", event, eventId)).toBe(200);
    expect(retrievals).toBe(2); // A processed replay does not reconcile again.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.invoices.list).toHaveBeenCalledTimes(1);
    expect(await retryState()).toMatchObject({ status: "forfeited", membership_tier: "Free" });
  } finally {
    await pool.query("DELETE FROM membership_webhook_events WHERE id = $1", [eventId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [retryClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [retryClerkId]);
  }
});

test("an already canceled subscription ends access even when invoice history is unavailable", async () => {
  const canceledClerkId = `billing-ended-${id}`;
  const canceledSubscriptionId = `sub_billing_ended_${id}`;
  const cancel = vi.fn();
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: {
      retrieve: async (requestedId: string) => {
        expect(requestedId).toBe(canceledSubscriptionId);
        return { status: "canceled", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
      },
      cancel,
    },
    invoices: { list: async () => { throw new Error("Invoice lookup unavailable"); } },
  } as unknown as Stripe);
  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [canceledClerkId, "Ended membership fixture", `${canceledClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id, failed_months) VALUES ($1, 'founding', 'confirmed', $2, 0)",
      [canceledClerkId, canceledSubscriptionId],
    );
    await reconcileMemberships(canceledSubscriptionId);
    expect(cancel).not.toHaveBeenCalled();
    expect(await state(canceledSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 0, last_failed_invoice: null, membership_tier: "Free",
    });
  } finally {
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [canceledClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [canceledClerkId]);
  }
});

test("a lost cancellation response rolls back the webhook, then redelivery observes canceled Stripe state", async () => {
  const lostClerkId = `billing-cancel-lost-${id}`;
  const lostSubscriptionId = `sub_billing_cancel_lost_${id}`;
  const eventId = `evt_billing_cancel_lost_${id}`;
  const failures = [
    invoice("lost-mar", "2026-03-01", "open"),
    invoice("lost-feb", "2026-02-01", "open"),
    invoice("lost-jan", "2026-01-01", "uncollectible"),
  ];
  const event = {
    object: "invoice",
    id: failures[0].id,
    parent: { subscription_details: { subscription: lostSubscriptionId } },
  };
  let stripeStatus: Stripe.Subscription.Status = "active";
  let invoiceOutage = false;
  const retrieve = vi.fn(async (requestedId: string) => {
    expect(requestedId).toBe(lostSubscriptionId);
    return { status: stripeStatus, cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
  });
  const cancel = vi.fn(async (requestedId: string) => {
    expect(requestedId).toBe(lostSubscriptionId);
    stripeStatus = "canceled"; // Stripe committed the cancellation, but its reply was lost.
    throw new Error("Cancellation response lost");
  });
  const list = vi.fn(async (params: { subscription: string }) => {
    expect(params.subscription).toBe(lostSubscriptionId);
    if (invoiceOutage) throw new Error("Invoice lookup unavailable");
    return { data: failures, has_more: false };
  });
  vi.mocked(getStripeSync).mockResolvedValue({ processWebhook: vi.fn().mockResolvedValue(undefined) } as never);
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: { retrieve, cancel },
    invoices: { list },
  } as unknown as Stripe);

  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [lostClerkId, "Lost cancellation response fixture", `${lostClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
      [lostClerkId, lostSubscriptionId],
    );
    const recordedEvents = async () =>
      (await pool.query("SELECT id FROM membership_webhook_events WHERE id = $1", [eventId])).rows;

    expect(await deliver("invoice.payment_failed", event, eventId)).toBe(400);
    expect(stripeStatus).toBe("canceled");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await recordedEvents()).toEqual([]);
    expect(await state(lostSubscriptionId)).toEqual({
      status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
    });

    invoiceOutage = true;
    expect(await deliver("invoice.payment_failed", event, eventId)).toBe(200);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(3); // The canceled retry tries history without re-canceling.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await recordedEvents()).toEqual([{ id: eventId }]);
    expect(await state(lostSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 0, last_failed_invoice: null, membership_tier: "Free",
    });
    const historyState = async () => (await pool.query<{
      invoice_history_pending: boolean; invoice_history_retry_count: number; invoice_history_retry_at: Date | null;
    }>(
      "SELECT invoice_history_pending, invoice_history_retry_count, invoice_history_retry_at FROM membership_checkouts WHERE stripe_subscription_id = $1",
      [lostSubscriptionId],
    )).rows[0];
    expect(await historyState()).toMatchObject({ invoice_history_pending: true, invoice_history_retry_count: 1 });
    expect((await historyState()).invoice_history_retry_at!.getTime()).toBeGreaterThan(Date.now());

    await reconcileMemberships(lostSubscriptionId);
    expect(list).toHaveBeenCalledTimes(3); // No hot-loop during the backoff window.
    await pool.query(
      "UPDATE membership_checkouts SET invoice_history_retry_at = now() - interval '1 second' WHERE stripe_subscription_id = $1",
      [lostSubscriptionId],
    );
    await reconcileMemberships(lostSubscriptionId);
    expect(list).toHaveBeenCalledTimes(4);
    expect(await historyState()).toMatchObject({ invoice_history_pending: true, invoice_history_retry_count: 2 });
    expect(await state(lostSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 0, last_failed_invoice: null, membership_tier: "Free",
    });

    invoiceOutage = false;
    await reconcileMemberships(lostSubscriptionId);
    expect(list).toHaveBeenCalledTimes(4); // Recovery still waits for the next due retry.
    await pool.query(
      "UPDATE membership_checkouts SET invoice_history_retry_at = now() - interval '1 second' WHERE stripe_subscription_id = $1",
      [lostSubscriptionId],
    );
    await reconcileMemberships(lostSubscriptionId);
    expect(list).toHaveBeenCalledTimes(5);
    expect(retrieve).toHaveBeenCalledTimes(2); // History repair never retrieves or changes subscription.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await historyState()).toEqual({
      invoice_history_pending: false, invoice_history_retry_count: 0, invoice_history_retry_at: null,
    });
    expect(await state(lostSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 3, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
    expect(await deliver("invoice.payment_failed", event, eventId)).toBe(200);
    await reconcileMemberships(lostSubscriptionId);
    expect(list).toHaveBeenCalledTimes(5);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await state(lostSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 3, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
  } finally {
    await pool.query("DELETE FROM membership_webhook_events WHERE id = $1", [eventId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [lostClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [lostClerkId]);
  }
});

test("a sweep ends access after a lost cancellation response without webhook redelivery or a second cancellation", async () => {
  const sweepClerkId = `billing-cancel-sweep-${id}`;
  const sweepSubscriptionId = `sub_billing_cancel_sweep_${id}`;
  const eventId = `evt_billing_cancel_sweep_${id}`;
  const failures = [
    invoice("sweep-mar", "2026-03-01", "open"),
    invoice("sweep-feb", "2026-02-01", "open"),
    invoice("sweep-jan", "2026-01-01", "uncollectible"),
  ];
  let stripeStatus: Stripe.Subscription.Status = "active";
  const retrieve = vi.fn(async (requestedId: string) => {
    expect(requestedId).toBe(sweepSubscriptionId);
    return { status: stripeStatus, cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
  });
  const cancel = vi.fn(async (requestedId: string) => {
    expect(requestedId).toBe(sweepSubscriptionId);
    stripeStatus = "canceled"; // The cancellation succeeded, but the response was lost.
    throw new Error("Cancellation response lost");
  });
  const list = vi.fn(async (params: { subscription: string }) => {
    expect(params.subscription).toBe(sweepSubscriptionId);
    return { data: failures, has_more: false };
  });
  vi.mocked(getStripeSync).mockResolvedValue({ processWebhook: vi.fn().mockResolvedValue(undefined) } as never);
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: { retrieve, cancel },
    invoices: { list },
  } as unknown as Stripe);

  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [sweepClerkId, "Lost cancellation sweep fixture", `${sweepClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
      [sweepClerkId, sweepSubscriptionId],
    );
    const recordedEvents = async () =>
      (await pool.query("SELECT id FROM membership_webhook_events WHERE id = $1", [eventId])).rows;

    expect(await deliver("invoice.payment_failed", {
      object: "invoice", id: failures[0].id,
      parent: { subscription_details: { subscription: sweepSubscriptionId } },
    }, eventId)).toBe(400);
    expect(stripeStatus).toBe("canceled");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await recordedEvents()).toEqual([]);
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
    });

    // No webhook retry arrives; the next sweep must recover from Stripe's current state.
    await reconcileMemberships(sweepSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(3); // The sweep reads invoice history to preserve the cause of forfeiture.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await recordedEvents()).toEqual([]);
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 3, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });

    await reconcileMemberships(sweepSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 3, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
  } finally {
    await pool.query("DELETE FROM membership_webhook_events WHERE id = $1", [eventId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [sweepClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [sweepClerkId]);
  }
});
