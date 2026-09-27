import type { PoolClient } from "@workspace/db";

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

export async function expireCheckout(client: Client, sessionId: string): Promise<void> {
  await client.query(
    "UPDATE membership_checkouts SET status = 'expired' WHERE stripe_session_id = $1 AND status = 'pending'",
    [sessionId],
  );
}