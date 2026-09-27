import { pool } from "@workspace/db";
import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 60_000;

// A rollback removes the reservation, so the Stripe ID must survive in its own transaction.
export async function queueCheckoutExpiration(sessionId: string): Promise<void> {
  await pool.query(
    "INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [sessionId],
  );
}

export async function recoverCheckoutExpiration(sessionId: string, stripe: Stripe): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  // A paid session must never be expired, even if its status is unexpectedly still open.
  if (session.status === "open" && session.payment_status !== "paid") {
    await stripe.checkout.sessions.expire(sessionId);
  } else if (session.status !== "expired" && session.status !== "complete" && session.payment_status !== "paid") {
    throw new Error(`Unexpected checkout session status: ${session.status}`);
  }
  await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = $1", [sessionId]);
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
            await recoverCheckoutExpiration(stripe_session_id, stripe);
          } catch (err) {
            logger.error({ err, stripeSessionId: stripe_session_id }, "Checkout expiration recovery failed");
          }
        }
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