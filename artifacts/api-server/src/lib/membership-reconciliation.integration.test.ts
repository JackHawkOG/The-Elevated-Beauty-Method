import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "./ensure-membership-schema";
import { requireDevelopmentDatabase } from "../routes/test-development-database";

vi.mock("./stripeClient", () => ({
  getStripeSync: vi.fn(),
  getUncachableStripeClient: vi.fn(),
}));

import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { reconcileMemberships, unresolvedReconciliationAlerts, outstandingReviewNotifications } from "./membership-reconciliation";
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
let fixtureLock: PoolClient | undefined;
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
  fixtureLock = await pool.connect();
  // Reconciliation fixtures affect global counts/capacity in other test runs.
  // Coordinate their entire lifetime with the count and reservation suites.
  await fixtureLock.query("SELECT pg_advisory_lock(20261001, 55)");
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
}, 30000);

afterAll(async () => {
  try {
    if (!seeded) return;
    await pool.query("DELETE FROM membership_webhook_events WHERE id = ANY($1::text[])", [eventIds]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId, paidDuringReviewClerkId]]);
    await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId, paidDuringReviewClerkId]]);
  } finally {
    if (fixtureLock) {
      await fixtureLock.query("SELECT pg_advisory_unlock(20261001, 55)");
      fixtureLock.release();
    }
  }
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

test("ending one of two confirmed subscriptions preserves access until the remaining subscription ends", async () => {
  const memberClerkId = `billing-two-subscriptions-${id}`;
  const firstSubscriptionId = `sub_billing_two_first_${id}`;
  const remainingSubscriptionId = `sub_billing_two_remaining_${id}`;
  const statuses = new Map<string, Stripe.Subscription.Status>([
    [firstSubscriptionId, "active"],
    [remainingSubscriptionId, "active"],
  ]);
  const retrieve = vi.fn(async (requestedId: string) => {
    expect(statuses.has(requestedId)).toBe(true);
    return {
      status: statuses.get(requestedId), cancel_at: null, cancel_at_period_end: false,
    } as Stripe.Subscription;
  });
  const cancel = vi.fn();
  const list = vi.fn(async (params: { subscription: string; limit: number }) => {
    expect(statuses.has(params.subscription)).toBe(true);
    expect(params.limit).toBe(100);
    return { data: [], has_more: false };
  });
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: { retrieve, cancel },
    invoices: { list },
  } as unknown as Stripe);

  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [memberClerkId, "Two subscriptions fixture", `${memberClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2), ($1, 'founding', 'confirmed', $3)",
      [memberClerkId, firstSubscriptionId, remainingSubscriptionId],
    );
    const confirmed = {
      status: "confirmed", failed_months: 0, last_failed_invoice: null, membership_tier: "Elevated",
    };
    expect(await state(firstSubscriptionId)).toEqual(confirmed);
    expect(await state(remainingSubscriptionId)).toEqual(confirmed);

    statuses.set(firstSubscriptionId, "canceled");
    await reconcileMemberships(firstSubscriptionId);
    expect(retrieve).toHaveBeenCalledWith(firstSubscriptionId);
    expect(await state(firstSubscriptionId)).toEqual({ ...confirmed, status: "forfeited" });
    expect(await state(remainingSubscriptionId)).toEqual(confirmed);

    // Rechecking the ended checkout and reviewing the active one cannot remove access.
    await reconcileMemberships(firstSubscriptionId);
    await reconcileMemberships(remainingSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(await state(firstSubscriptionId)).toEqual({ ...confirmed, status: "forfeited" });
    expect(await state(remainingSubscriptionId)).toEqual(confirmed);

    statuses.set(remainingSubscriptionId, "canceled");
    await reconcileMemberships(remainingSubscriptionId);
    const ended = { ...confirmed, status: "forfeited", membership_tier: "Free" };
    expect(await state(firstSubscriptionId)).toEqual(ended);
    expect(await state(remainingSubscriptionId)).toEqual(ended);
    await reconcileMemberships(firstSubscriptionId);
    await reconcileMemberships(remainingSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(cancel).not.toHaveBeenCalled();
    expect(await state(firstSubscriptionId)).toEqual(ended);
    expect(await state(remainingSubscriptionId)).toEqual(ended);
  } finally {
    await pool.query("DELETE FROM membership_reconciliation_failures WHERE stripe_subscription_id = ANY($1::text[])",
      [[firstSubscriptionId, remainingSubscriptionId]]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [memberClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [memberClerkId]);
  }
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

test("a later sweep recovers from a temporary subscription retrieval outage without canceling again", async () => {
  const sweepClerkId = `billing-status-outage-${id}`;
  const sweepSubscriptionId = `sub_billing_status_outage_${id}`;
  const previousFailure = invoice("status-outage-feb", "2026-02-01", "open");
  const failures = [invoice("status-outage-mar", "2026-03-01", "open"), previousFailure];
  const retrieve = vi.fn(async (requestedId: string) => {
    expect(requestedId).toBe(sweepSubscriptionId);
    if (retrieve.mock.calls.length === 1) throw new Error("Temporary Stripe status outage");
    return { status: "canceled", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
  });
  const cancel = vi.fn();
  const list = vi.fn(async (params: { subscription: string; limit: number }) => {
    expect(params).toEqual({ subscription: sweepSubscriptionId, limit: 100 });
    return { data: failures, has_more: false };
  });
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: { retrieve, cancel },
    invoices: { list },
  } as unknown as Stripe);

  await pool.query(
    "INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $2, $3, 'Elevated')",
    [sweepClerkId, "Stripe status outage fixture", `${sweepClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id, failed_months, last_failed_invoice) VALUES ($1, 'founding', 'confirmed', $2, 1, $3)",
      [sweepClerkId, sweepSubscriptionId, previousFailure.id],
    );
    const recordedFailures = async () => (await pool.query<{ consecutive_failures: number }>(
      "SELECT consecutive_failures FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1",
      [sweepSubscriptionId],
    )).rows;

    // No webhook or cancellation request is involved: only the status read fails.
    await reconcileMemberships(sweepSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "confirmed", failed_months: 1, last_failed_invoice: previousFailure.id, membership_tier: "Elevated",
    });
    expect(await recordedFailures()).toEqual([{ consecutive_failures: 1 }]);

    await reconcileMemberships(sweepSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 2, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
    expect(await recordedFailures()).toEqual([]);

    // Subsequent sweeps leave the forfeiture final without more Stripe calls.
    await reconcileMemberships(sweepSubscriptionId);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await state(sweepSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 2, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
  } finally {
    await pool.query("DELETE FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1", [sweepSubscriptionId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [sweepClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [sweepClerkId]);
  }
});

test("an unfiltered sweep continues after a failed status lookup and ends another member's access", async () => {
  const failedClerkId = `billing-batch-failed-${id}`;
  const failedSubscriptionId = `sub_billing_batch_failed_${id}`;
  const canceledClerkId = `billing-batch-canceled-${id}`;
  const canceledSubscriptionId = `sub_billing_batch_canceled_${id}`;
  const previousFailure = invoice("batch-feb", "2026-02-01", "open");
  const failures = [invoice("batch-mar", "2026-03-01", "open"), previousFailure];
  const retrieve = vi.fn(async (requestedId: string) => {
    if (requestedId === failedSubscriptionId) throw new Error("Temporary Stripe status outage");
    expect(requestedId).toBe(canceledSubscriptionId);
    return { status: "canceled", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
  });
  const cancel = vi.fn();
  const list = vi.fn(async (params: { subscription: string; limit: number }) => {
    expect(params).toEqual({ subscription: canceledSubscriptionId, limit: 100 });
    return { data: failures, has_more: false };
  });
  vi.mocked(getUncachableStripeClient).mockResolvedValue({
    subscriptions: { retrieve, cancel },
    invoices: { list },
  } as unknown as Stripe);

  const client = await pool.connect();
  let connectSpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    // Bound waiting for a live background sweep, then retain its session lock.
    // The sweep's own acquisition is reentrant on this same private connection.
    await client.query("SET statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock(20261001, 56)");
    // Copy structure, never data. Exclude public from name resolution so a
    // missing fixture table fails closed instead of falling through to members.
    await client.query(`
      CREATE TEMP TABLE users (LIKE public.users INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE membership_checkouts (LIKE public.membership_checkouts INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE membership_reconciliation_failures (LIKE public.membership_reconciliation_failures INCLUDING DEFAULTS INCLUDING INDEXES);
      CREATE TEMP TABLE membership_sweep_health (LIKE public.membership_sweep_health INCLUDING DEFAULTS INCLUDING INDEXES);
      ALTER TABLE pg_temp.users ALTER COLUMN id DROP DEFAULT;
      ALTER TABLE pg_temp.membership_checkouts ALTER COLUMN id DROP DEFAULT;
      SET search_path = pg_temp, pg_catalog;
    `);
    await client.query(`
      INSERT INTO users (id, clerk_id, display_name, email, membership_tier)
      VALUES (1, $1, 'Batch failed fixture', $2, 'Elevated'),
             (2, $3, 'Batch canceled fixture', $4, 'Elevated')
    `, [failedClerkId, `${failedClerkId}@example.invalid`, canceledClerkId, `${canceledClerkId}@example.invalid`]);
    // Fixed private IDs guarantee the failure occurs before the canceled row.
    await client.query(`
      INSERT INTO membership_checkouts (id, clerk_id, kind, status, stripe_subscription_id, failed_months, last_failed_invoice)
      VALUES (1, $1, 'founding', 'confirmed', $2, 1, $5),
             (2, $3, 'founding', 'confirmed', $4, 1, $5)
    `, [failedClerkId, failedSubscriptionId, canceledClerkId, canceledSubscriptionId, previousFailure.id]);
    const privateState = async (forSubscriptionId: string) => (await client.query<MembershipState>(
      "SELECT m.status, m.failed_months, m.last_failed_invoice, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_subscription_id = $1",
      [forSubscriptionId],
    )).rows[0];
    const unchanged = await privateState(failedSubscriptionId);
    expect(unchanged).toEqual({
      status: "confirmed", failed_months: 1, last_failed_invoice: previousFailure.id, membership_tier: "Elevated",
    });

    // Only the connection lease is mocked; all sweep SQL, transactions, row
    // locks, access updates and failure records run against real PostgreSQL.
    const release = vi.fn();
    connectSpy = vi.spyOn(pool, "connect").mockImplementation(async () => ({
      query: client.query.bind(client),
      release,
    } as unknown as PoolClient));
    await reconcileMemberships(); // Deliberately no subscription filter.

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenNthCalledWith(1, failedSubscriptionId);
    expect(retrieve).toHaveBeenNthCalledWith(2, canceledSubscriptionId);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(await privateState(failedSubscriptionId)).toEqual(unchanged);
    expect(await privateState(canceledSubscriptionId)).toEqual({
      status: "forfeited", failed_months: 2, last_failed_invoice: failures[0].id, membership_tier: "Free",
    });
    expect((await client.query(
      "SELECT stripe_subscription_id, consecutive_failures FROM membership_reconciliation_failures",
    )).rows).toEqual([{ stripe_subscription_id: failedSubscriptionId, consecutive_failures: 1 }]);
  } finally {
    connectSpy?.mockRestore();
    try {
      // Even failed setup/assertions cannot leave fixtures or failure records.
      await client.query("ROLLBACK");
      await client.query(`
        DROP TABLE IF EXISTS pg_temp.membership_reconciliation_failures,
          pg_temp.membership_sweep_health, pg_temp.membership_checkouts, pg_temp.users;
      `);
    } finally {
      // Destroy, rather than pool, the session with changed search_path and
      // the retained advisory lock; this also removes any remaining temp data.
      client.release(true);
    }
  }
}, 30000);

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

test("three consecutive founding review failures alert staff, and a successful review clears the alert", async () => {
  const reviewClerkId = `billing-review-alert-${id}`;
  const reviewSubscriptionId = `sub_billing_review_alert_${id}`;
  const standardClerkId = `billing-standard-alert-${id}`;
  const standardSubscriptionId = `sub_billing_standard_alert_${id}`;
  const failing = new Set([reviewSubscriptionId, standardSubscriptionId]);
  const stripe = {
    subscriptions: { retrieve: vi.fn(async (requestedId: string) => {
      if (failing.has(requestedId)) throw new Error("Stripe temporarily unavailable");
      return { status: "active", cancel_at: null, cancel_at_period_end: false } as Stripe.Subscription;
    }) },
    invoices: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  } as unknown as Stripe;
  vi.mocked(getUncachableStripeClient).mockResolvedValue(stripe);
  await pool.query(
    `INSERT INTO users (clerk_id, display_name, email, membership_tier)
     VALUES ($1, $1, $2, 'Elevated'), ($3, $3, $4, 'Elevated')`,
    [reviewClerkId, `${reviewClerkId}@example.invalid`, standardClerkId, `${standardClerkId}@example.invalid`],
  );
  try {
    await pool.query(
      `INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id)
       VALUES ($1, 'founding', 'confirmed', $2), ($3, 'standard', 'confirmed', $4)`,
      [reviewClerkId, reviewSubscriptionId, standardClerkId, standardSubscriptionId],
    );
    const failureCount = async () => (await pool.query<{ consecutive_failures: number }>(
      "SELECT consecutive_failures FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1",
      [reviewSubscriptionId],
    )).rows[0]?.consecutive_failures;
    const notice = async () => (await pool.query<{ notification_id: string | null; notified_at: Date | null }>(
      "SELECT notification_id, notified_at FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1",
      [reviewSubscriptionId],
    )).rows[0];

    await reconcileMemberships(reviewSubscriptionId);
    expect(await failureCount()).toBe(1);
    expect(await notice()).toEqual({ notification_id: null, notified_at: null });
    expect((await unresolvedReconciliationAlerts()).subscriptions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: reviewSubscriptionId }),
    ]));
    await reconcileMemberships(reviewSubscriptionId);
    expect(await failureCount()).toBe(2);
    expect(await notice()).toEqual({ notification_id: null, notified_at: null });
    expect((await unresolvedReconciliationAlerts()).subscriptions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: reviewSubscriptionId }),
    ]));
    await reconcileMemberships(reviewSubscriptionId);
    expect((await unresolvedReconciliationAlerts()).subscriptions).toContainEqual(expect.objectContaining({
      subscriptionId: reviewSubscriptionId, consecutiveFailures: 3,
      firstFailedAt: expect.any(String), lastFailedAt: expect.any(String),
    }));
    // No membership-page request is involved in creating the notification.
    const firstNotice = (await notice())!;
    expect(firstNotice).toEqual({ notification_id: expect.any(String), notified_at: expect.any(Date) });
    const publicNotice = { id: firstNotice.notification_id, createdAt: firstNotice.notified_at!.toISOString() };
    expect(await outstandingReviewNotifications()).toContainEqual(publicNotice);
    await reconcileMemberships(reviewSubscriptionId);
    await reconcileMemberships(reviewSubscriptionId);
    expect(await failureCount()).toBe(5);
    expect(await notice()).toEqual(firstNotice);
    expect((await outstandingReviewNotifications()).filter(item => item.id === firstNotice.notification_id)).toEqual([publicNotice]);
    await reconcileMemberships(standardSubscriptionId);
    await reconcileMemberships(standardSubscriptionId);
    await reconcileMemberships(standardSubscriptionId);
    expect((await pool.query("SELECT * FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1", [standardSubscriptionId])).rows).toEqual([]);

    failing.delete(reviewSubscriptionId);
    await reconcileMemberships(reviewSubscriptionId);
    expect(await failureCount()).toBeUndefined();
    expect(await outstandingReviewNotifications()).not.toContainEqual(publicNotice);
    expect((await unresolvedReconciliationAlerts()).subscriptions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: reviewSubscriptionId }),
    ]));

    // A new isolated failure must start from one again.
    failing.add(reviewSubscriptionId);
    await reconcileMemberships(reviewSubscriptionId);
    expect(await failureCount()).toBe(1);
    expect(await notice()).toEqual({ notification_id: null, notified_at: null });
    await reconcileMemberships(reviewSubscriptionId);
    await reconcileMemberships(reviewSubscriptionId);
    expect((await notice())!.notification_id).not.toBe(firstNotice.notification_id);
  } finally {
    await pool.query("DELETE FROM membership_reconciliation_failures WHERE stripe_subscription_id = ANY($1::text[])", [[reviewSubscriptionId, standardSubscriptionId]]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [[reviewClerkId, standardClerkId]]);
    await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[reviewClerkId, standardClerkId]]);
  }
});

test("repeated database write failures alert staff without clearing the streak before a successful commit", async () => {
  const reviewClerkId = `billing-db-review-${id}`;
  const reviewSubscriptionId = `sub_billing_db_review_${id}`;
  const stripe = {
    subscriptions: { retrieve: vi.fn(async () => ({
      status: "active", cancel_at: null, cancel_at_period_end: false,
    })) },
    invoices: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  } as unknown as Stripe;
  vi.mocked(getUncachableStripeClient).mockResolvedValue(stripe);
  await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, $1, $2, 'Elevated')",
    [reviewClerkId, `${reviewClerkId}@example.invalid`]);
  const originalConnect = pool.connect.bind(pool);
  const queryRestorers: (() => void)[] = [];
  const connectSpy = vi.spyOn(pool, "connect");
  const failNextWrite = () => connectSpy.mockImplementationOnce(async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const querySpy = vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" &&
          args[0].startsWith("UPDATE membership_checkouts SET failed_months")) {
        return Promise.reject(new Error("Simulated membership status write failure"));
      }
      return (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    queryRestorers.push(() => querySpy.mockRestore());
    return client;
  });
  try {
    await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ($1, 'founding', 'confirmed', $2)",
      [reviewClerkId, reviewSubscriptionId]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      failNextWrite();
      await reconcileMemberships(reviewSubscriptionId);
      // Restore before pool.query borrows the same connection for assertions.
      queryRestorers.splice(0).forEach(restore => restore());
      expect((await pool.query("SELECT consecutive_failures FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1",
        [reviewSubscriptionId])).rows[0].consecutive_failures).toBe(attempt);
      const alert = (await unresolvedReconciliationAlerts()).subscriptions.find(item => item.subscriptionId === reviewSubscriptionId);
      expect(Boolean(alert)).toBe(attempt === 3);
    }
    expect(await state(reviewSubscriptionId)).toMatchObject({ status: "confirmed", membership_tier: "Elevated" });
    await reconcileMemberships(reviewSubscriptionId);
    expect((await pool.query("SELECT 1 FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1",
      [reviewSubscriptionId])).rows).toEqual([]);
    expect((await unresolvedReconciliationAlerts()).subscriptions.some(item => item.subscriptionId === reviewSubscriptionId)).toBe(false);
  } finally {
    connectSpy.mockRestore();
    queryRestorers.splice(0).forEach(restore => restore());
    await pool.query("DELETE FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1", [reviewSubscriptionId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [reviewClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [reviewClerkId]);
  }
});
