import type { PoolClient } from "@workspace/db";
import type Stripe from "stripe";
import { isSubscriptionEnded } from "./membership-reconciliation";

type Client = PoolClient;
export const FOUNDING_LIMIT = 50;
// Stripe requires at least 30 minutes remaining when it receives the request,
// not when our server begins building it.
export function checkoutExpiry(now = Date.now()): number {
  return Math.ceil(now / 1000) + 35 * 60;
}

// Every checkout must hold the same transaction-level lock across the count,
// Stripe session creation, and reservation insert/commit.
export async function lockMembershipCapacity(client: Client): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(20261001, 50)");
}

export async function hasFoundingCapacity(client: Client): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM membership_checkouts WHERE kind = 'founding' AND status IN ('pending', 'confirmed', 'forfeited')",
  );
  return Number(result.rows[0].count) < FOUNDING_LIMIT;
}

export async function confirmCheckout(client: Client, sessionId: string, subscriptionId: string): Promise<boolean> {
  const result = await client.query<{ clerk_id: string }>(
    "UPDATE membership_checkouts SET status = 'confirmed', stripe_subscription_id = $1 WHERE stripe_session_id = $2 AND status = 'pending' RETURNING clerk_id",
    [subscriptionId, sessionId],
  );
  if (result.rows[0]) await client.query("UPDATE users SET membership_tier = 'Elevated' WHERE clerk_id = $1", [result.rows[0].clerk_id]);
  return Boolean(result.rows[0]);
}

// Only used when no local reservation survived. Never trust the webhook body
// for identity, plan, payment, or subscription ownership: retrieve all of them
// from Stripe before recreating a row.
export async function restorePaidCheckout(client: Client, stripe: Stripe, sessionId: string): Promise<boolean> {
  await lockMembershipCapacity(client);
  const existing = await client.query(
    "SELECT 1 FROM membership_checkouts WHERE stripe_session_id = $1 LIMIT 1",
    [sessionId],
  );
  if (existing.rowCount) return false;

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== "subscription" || session.status !== "complete" || session.payment_status !== "paid"
      || session.metadata?.membershipCheckout !== "true" || !/^[1-9]\d*$/.test(session.metadata.reservationId ?? "")
      || typeof session.client_reference_id !== "string" || !session.client_reference_id
      || typeof session.customer !== "string" || typeof session.subscription !== "string") return false;

  const customer = await stripe.customers.retrieve(session.customer);
  if (customer.deleted || customer.metadata?.clerkId !== session.client_reference_id) return false;
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const subscriptionCustomer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (subscriptionCustomer !== session.customer || subscription.metadata?.reservationId !== session.metadata.reservationId) return false;

  const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
  if (items.has_more || items.data.length !== 1 || items.data[0].quantity !== 1) return false;
  const priceId = typeof items.data[0].price === "string" ? items.data[0].price : items.data[0].price?.id;
  const prices = await stripe.prices.list({ lookup_keys: ["founding_2026", "standard_2026"], active: true, limit: 10 });
  const kind = (["founding", "standard"] as const).find(candidate => {
    const expected = candidate === "founding" ? 2400 : 4800;
    return prices.data.some(price => price.id === priceId && price.lookup_key === `${candidate}_2026`
      && price.unit_amount === expected && price.currency === "usd" && price.recurring?.interval === "month");
  });
  if (!kind) return false;

  const user = await client.query("SELECT 1 FROM users WHERE clerk_id = $1", [session.client_reference_id]);
  if (!user.rowCount) return false;
  const conflict = await client.query<{ status: string; stripe_session_id: string | null }>(
    "SELECT status, stripe_session_id FROM membership_checkouts WHERE clerk_id = $1 AND status IN ('pending', 'confirmed') FOR UPDATE",
    [session.client_reference_id],
  );
  for (const row of conflict.rows) {
    if (row.status === "confirmed" || !row.stripe_session_id) {
      throw new Error(`Paid checkout ${sessionId} conflicts with an existing membership`);
    }
    const later = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
    if (later.status === "open" && later.payment_status !== "paid") {
      // Stripe rejects expiration if payment wins this race; in that case
      // retry rather than claiming a second paid checkout is unpaid.
      await stripe.checkout.sessions.expire(later.id);
    } else if (later.status !== "expired") {
      throw new Error(`Paid checkout ${sessionId} conflicts with another paid checkout`);
    }
    await client.query(
      "UPDATE membership_checkouts SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'",
      [row.stripe_session_id],
    );
  }

  // A paid founding place must be honored even if newer pending checkouts
  // were created after the lost reservation. This row counts toward capacity.
  const status = isSubscriptionEnded(subscription) ? "forfeited" : "confirmed";
  const inserted = await client.query(
    `INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_session_id, stripe_subscription_id, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id`,
    [session.client_reference_id, kind, status, session.id, session.subscription, session.customer],
  );
  if (inserted.rowCount && status === "confirmed") {
    await client.query("UPDATE users SET membership_tier = 'Elevated' WHERE clerk_id = $1", [session.client_reference_id]);
  }
  return Boolean(inserted.rowCount);
}

export async function expireCheckout(client: Client, sessionId: string): Promise<void> {
  await client.query(
    "UPDATE membership_checkouts SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'",
    [sessionId],
  );
}