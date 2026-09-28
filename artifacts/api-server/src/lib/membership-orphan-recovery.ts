import { pool } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 10 * 60_000;

// A lost response from Stripe can leave a session whose reservation rolled
// back. The idempotency key cannot recover its ID after that rollback.
export async function expireUntrackedMembershipSessions(): Promise<void> {
  const client = await pool.connect();
  try {
    // One scanner across all instances; do not stack scans when Stripe is slow.
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(20261001, 58) AS acquired",
    );
    if (!lock.rows[0]?.acquired) return;
    try {
      const stripe = await getUncachableStripeClient();
      const cutoff = Math.floor(Date.now() / 1000) - 31 * 60;
      let startingAfter: string | undefined;
      while (true) {
        const page = await stripe.checkout.sessions.list({
          status: "open",
          created: { lte: cutoff },
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const session of page.data) {
          try {
            if (session.metadata?.membershipCheckout !== "true" || !session.metadata.reservationId) continue;
            const tracked = await client.query(
              "SELECT 1 FROM membership_checkouts WHERE stripe_session_id = $1 OR id = $2 LIMIT 1",
              [session.id, session.metadata.reservationId],
            );
            if (tracked.rowCount) continue;
            // Listing can race with payment. Never expire a paid session, even
            // if Stripe unexpectedly still reports its status as open.
            const current = await stripe.checkout.sessions.retrieve(session.id);
            if (current.status === "open" && current.payment_status !== "paid") {
              await stripe.checkout.sessions.expire(session.id);
            }
          } catch (err) {
            logger.error({ err, stripeSessionId: session?.id }, "Membership orphan session cleanup failed");
          }
        }
        if (!page.has_more) break;
        if (!page.data.length) throw new Error("Stripe returned an empty checkout page with more results");
        startingAfter = page.data[page.data.length - 1].id;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(20261001, 58)");
    }
  } finally {
    client.release();
  }
}

export function startMembershipOrphanRecovery(): void {
  const run = () => {
    void expireUntrackedMembershipSessions().catch(err => logger.error({ err }, "Membership orphan recovery failed"));
  };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}