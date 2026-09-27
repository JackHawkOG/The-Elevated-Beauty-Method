import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { pool } from "@workspace/db";
import { ensureMembershipSchema } from "./ensure-membership-schema";

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
const eventIds: string[] = [];
let seeded = false;

function assertDevelopmentDatabase(): void {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT ||
      !process.env.DATABASE_URL || !process.env.PGHOST || !process.env.PGPORT ||
      !process.env.PGDATABASE || !process.env.PGUSER) {
    throw new Error("Billing race test requires the workspace development database");
  }
  const target = new URL(process.env.DATABASE_URL);
  if (target.protocol !== "postgresql:" && target.protocol !== "postgres:") {
    throw new Error("Billing race test requires a PostgreSQL development URL");
  }
  if (target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE ||
      decodeURIComponent(target.username) !== process.env.PGUSER) {
    throw new Error("Billing race test cannot run against a different database");
  }
}

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
async function state(): Promise<MembershipState> {
  const result = await pool.query<MembershipState>(
    "SELECT m.status, m.failed_months, m.last_failed_invoice, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_subscription_id = $1",
    [subscriptionId],
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
  assertDevelopmentDatabase();
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
});

afterAll(async () => {
  if (!seeded) return;
  await pool.query("DELETE FROM membership_webhook_events WHERE id = ANY($1::text[])", [eventIds]);
  await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId]]);
  await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[clerkId, otherClerkId]]);
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
    invoices: {
      list: async (params: { subscription: string }) => {
        expect(params.subscription).toBe(subscriptionId);
        return { data: invoices, has_more: false };
      },
    },
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