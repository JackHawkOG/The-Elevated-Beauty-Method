import { pool, type PoolClient } from "@workspace/db";
import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";
import { restorePaidCheckout } from "./membership-reservations";

const SWEEP_INTERVAL_MS = 60_000;
// Checkout sessions normally expire after 30 minutes; warn while intervention can still help.
export const CHECKOUT_CLEANUP_ALERT_AFTER_MINUTES = 10;

export async function overdueCheckoutExpirations(): Promise<{ total: number; sessions: { sessionId: string; queuedAt: string }[] }> {
  const result = await pool.query<{ total: number; stripe_session_id: string | null; created_at: Date | null }>(
    `WITH overdue AS (
       SELECT stripe_session_id, created_at FROM membership_checkout_expirations
       WHERE created_at <= now() - ($1::int * interval '1 minute')
     )
     SELECT (SELECT count(*)::int FROM overdue) AS total, stripe_session_id, created_at
     FROM (SELECT stripe_session_id, created_at FROM overdue ORDER BY created_at, stripe_session_id LIMIT 100) oldest
     RIGHT JOIN (SELECT 1) anchor ON true
     ORDER BY created_at, stripe_session_id`,
    [CHECKOUT_CLEANUP_ALERT_AFTER_MINUTES],
  );
  return {
    total: result.rows[0]?.total ?? 0,
    sessions: result.rows.filter((row): row is typeof row & { stripe_session_id: string; created_at: Date } =>
      row.stripe_session_id !== null && row.created_at !== null,
    ).map(row => ({ sessionId: row.stripe_session_id, queuedAt: row.created_at.toISOString() })),
  };
}

// A rollback removes the reservation, so the Stripe ID must survive in its own transaction.
export async function queueCheckoutExpiration(sessionId: string): Promise<void> {
  await pool.query(
    "INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [sessionId],
  );
}

export async function recoverCheckoutExpiration(sessionId: string, stripe: Stripe, lockedClient?: PoolClient): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status === "complete" && session.payment_status === "paid") {
    const client = lockedClient ?? await pool.connect();
    try {
      await client.query("BEGIN");
      await restorePaidCheckout(client, stripe, sessionId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      if (!lockedClient) client.release();
    }
  }
  // A paid session must never be expired, even if its status is unexpectedly still open.
  if (session.status === "open" && session.payment_status !== "paid") {
    await stripe.checkout.sessions.expire(sessionId);
  } else if (session.status !== "expired" && session.status !== "complete" && session.payment_status !== "paid") {
    throw new Error(`Unexpected checkout session status: ${session.status}`);
  }
  await (lockedClient ?? pool).query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = $1", [sessionId]);
}

// Use the same per-session lock in staff retries and scheduled sweeps. The lock
// stays held through Stripe and database reconciliation, across server instances.
export async function retryQueuedCheckoutExpiration(
  sessionId: string,
  getStripe: () => Promise<Stripe>,
  overdueOnly = false,
): Promise<"resolved" | "not_queued" | "busy"> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(20261001, hashtext($1)) AS acquired",
      [sessionId],
    );
    if (!lock.rows[0]?.acquired) return "busy";
    try {
      const pending = await client.query(
        `SELECT 1 FROM membership_checkout_expirations
         WHERE stripe_session_id = $1
         AND ($2::boolean = false OR created_at <= now() - ($3::int * interval '1 minute'))`,
        [sessionId, overdueOnly, CHECKOUT_CLEANUP_ALERT_AFTER_MINUTES],
      );
      if (!pending.rowCount) return "not_queued";
      await recoverCheckoutExpiration(sessionId, await getStripe(), client);
      return "resolved";
    } finally {
      await client.query("SELECT pg_advisory_unlock(20261001, hashtext($1))", [sessionId]);
    }
  } finally {
    client.release();
  }
}

export async function recoverQueuedCheckoutExpirations(): Promise<void> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(20261001, 57) AS acquired");
    if (!lock.rows[0]?.acquired) return;
    try {
      const stripe = await getUncachableStripeClient();
      let after = "";
      while (true) {
        const pending = await client.query<{ stripe_session_id: string }>(
          "SELECT stripe_session_id FROM membership_checkout_expirations WHERE stripe_session_id > $1 ORDER BY stripe_session_id LIMIT 100",
          [after],
        );
        if (!pending.rows.length) break;
        for (const { stripe_session_id } of pending.rows) {
          after = stripe_session_id;
          try {
            await retryQueuedCheckoutExpiration(stripe_session_id, async () => stripe);
          } catch (err) {
            logger.error({ err, stripeSessionId: stripe_session_id }, "Checkout expiration recovery failed");
          }
        }
      }
      const alerts = await overdueCheckoutExpirations();
      if (alerts.total) {
        logger.error({
          unresolvedCount: alerts.total,
          oldestSessionId: alerts.sessions[0]?.sessionId,
          oldestQueuedAt: alerts.sessions[0]?.queuedAt,
        }, "Membership checkout cleanup overdue; inspect Stripe session and retry status");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(20261001, 57)");
    }
  } finally {
    client.release();
  }
}

export function startCheckoutExpirationRecovery(): void {
  const run = () => {
    void recoverQueuedCheckoutExpirations().catch(err => logger.error({ err }, "Checkout expiration sweep failed"));
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}
