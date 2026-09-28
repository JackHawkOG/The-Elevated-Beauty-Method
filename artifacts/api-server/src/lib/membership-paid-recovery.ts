import { pool } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";
import { restorePaidCheckout } from "./membership-reservations";

const OPENED_AT = Math.floor(Date.parse("2026-10-01T14:00:00Z") / 1000);

export async function reconcileUntrackedPaidSessions(clerkId?: string): Promise<void> {
  const stripe = await getUncachableStripeClient();
  let startingAfter: string | undefined;
  do {
    const page = await stripe.checkout.sessions.list({
      status: "complete", created: { gte: OPENED_AT }, limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of page.data) {
      if (session.metadata?.membershipCheckout !== "true") continue;
      if (clerkId && session.client_reference_id !== clerkId) continue;
      const tracked = await pool.query("SELECT 1 FROM membership_checkouts WHERE stripe_session_id = $1", [session.id]);
      if (tracked.rowCount) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await restorePaidCheckout(client, stripe, session.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if (clerkId) throw error;
        logger.error({ err: error, stripeSessionId: session.id }, "Paid checkout recovery needs attention");
      } finally {
        client.release();
      }
    }
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Stripe returned an empty completed checkout page with more results");
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);
}

export function startUntrackedPaidCheckoutRecovery(): void {
  const run = () => {
    void reconcileUntrackedPaidSessions().catch(error =>
      logger.error({ err: error }, "Untracked paid checkout sweep failed"));
  };
  run();
  const timer = setInterval(run, 15 * 60_000);
  timer.unref();
}