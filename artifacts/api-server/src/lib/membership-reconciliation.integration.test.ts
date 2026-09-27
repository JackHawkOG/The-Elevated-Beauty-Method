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
});

afterAll(async () => {
  if (!seeded) return;
  await pool.query("DELETE FROM membership_webhook_events WHERE id = ANY($1::text[])", [eventIds]);
  await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId]]);
  await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId, paginatedClerkId]]);
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
    },
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
    expect(await retryState()).toMatchObject({ status: "forfeited", membership_tier: "Free" });
  } finally {
    await pool.query("DELETE FROM membership_webhook_events WHERE id = $1", [eventId]);
    await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [retryClerkId]);
    await pool.query("DELETE FROM users WHERE clerk_id = $1", [retryClerkId]);
  }
});
