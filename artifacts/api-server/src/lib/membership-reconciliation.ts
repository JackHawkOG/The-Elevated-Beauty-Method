import type { PoolClient } from "@workspace/db";
import { pool } from "@workspace/db";
import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 15 * 60_000;

// Paid renewal invoices end a run of failures. Retries of the same invoice
// and multiple invoices in one calendar month never count as extra months.
export function failedBillingMonths(invoices: Stripe.Invoice[]): { count: number; lastId: string | null } {
  const months = new Set<string>();
  let lastId: string | null = null;
  for (const invoice of [...invoices].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))) {
    if (invoice.billing_reason !== "subscription_cycle" || invoice.status === "draft" || invoice.status === "void") continue;
    if (invoice.status === "paid") break;
    if (invoice.attempt_count > 0 && (invoice.status === "open" || invoice.status === "uncollectible")) {
      lastId ??= invoice.id;
      months.add(new Date(invoice.created * 1000).toISOString().slice(0, 7));
    }
  }
  return { count: months.size, lastId };
}

export function scheduledCancellationTimestamp(subscription: Stripe.Subscription): number | null {
  return subscription.cancel_at ?? (subscription.cancel_at_period_end && subscription.items.data.length
    ? Math.max(...subscription.items.data.map(item => item.current_period_end))
    : null);
}

export function isSubscriptionEnded(subscription: Stripe.Subscription, now = Date.now()): boolean {
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired" || subscription.status === "unpaid") return true;
  // A scheduled cancellation does not end access until its effective date.
  const end = scheduledCancellationTimestamp(subscription);
  return end !== null && end * 1000 <= now;
}

async function currentFailedBillingMonths(stripe: Stripe, subscriptionId: string): Promise<{ count: number; lastId: string | null }> {
  // Three distinct months are sufficient to trigger forfeiture; paginate
  // until a paid renewal or the beginning of the subscription is reached.
  const invoices: Stripe.Invoice[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.list({ subscription: subscriptionId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    invoices.push(...page.data);
    const failed = failedBillingMonths(invoices);
    if (failed.count >= 3 || !page.has_more || page.data.length === 0 ||
        page.data.some(invoice => invoice.billing_reason === "subscription_cycle" && invoice.status === "paid")) return failed;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

// Call under a transaction. Lock BEFORE reading Stripe so an older webhook
// cannot write after a newer webhook or sweep has committed.
export async function reconcileSubscription(
  client: PoolClient,
  subscriptionId: string,
  stripe: Stripe,
): Promise<void> {
  const result = await client.query<{
    id: string; clerk_id: string; kind: string; status: string;
    failed_months: number; last_failed_invoice: string | null;
  }>(
    "SELECT id, clerk_id, kind, status, failed_months, last_failed_invoice FROM membership_checkouts WHERE stripe_subscription_id = $1 FOR UPDATE",
    [subscriptionId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "confirmed") return; // A forfeited founding place is permanent.

  let subscription = await stripe.subscriptions.retrieve(subscriptionId);
  let failed = { count: 0, lastId: null as string | null };
  if (row.kind === "founding") {
    // A cancellation may have succeeded at Stripe while its response was lost.
    // Read the same invoice history on redelivery so forfeiture keeps its cause.
    if (isSubscriptionEnded(subscription)) {
      try {
        failed = await currentFailedBillingMonths(stripe, subscriptionId);
      } catch (err) {
        // Ending access must not depend on a second Stripe API being available.
        logger.warn({ err, subscriptionId }, "Unable to read ended membership invoice history");
        failed = { count: row.failed_months, lastId: row.last_failed_invoice };
      }
    } else {
      failed = await currentFailedBillingMonths(stripe, subscriptionId);
    }
    if (!isSubscriptionEnded(subscription) && failed.count >= 3) {
      // The invoice snapshot can change while it is being paginated. Confirm
      // from a new first page before making the irreversible Stripe call.
      failed = await currentFailedBillingMonths(stripe, subscriptionId);
    }
    if (!isSubscriptionEnded(subscription) && failed.count >= 3) {
      // Stripe is the source of truth; a retry after a successful cancellation
      // observes canceled instead of issuing another cancellation.
      subscription = await stripe.subscriptions.cancel(subscriptionId);
    }
  }

  if (isSubscriptionEnded(subscription)) {
    await client.query(
      "UPDATE membership_checkouts SET status = 'forfeited', failed_months = $2, last_failed_invoice = $3 WHERE id = $1 AND status = 'confirmed'",
      [row.id, failed.count, failed.lastId],
    );
    await client.query(
      "UPDATE users SET membership_tier = 'Free' WHERE clerk_id = $1 AND NOT EXISTS (SELECT 1 FROM membership_checkouts WHERE clerk_id = $1 AND status = 'confirmed')",
      [row.clerk_id],
    );
  } else {
    await client.query(
      "UPDATE membership_checkouts SET failed_months = $2, last_failed_invoice = $3 WHERE id = $1 AND status = 'confirmed'",
      [row.id, failed.count, failed.lastId],
    );
    await client.query("UPDATE users SET membership_tier = 'Elevated' WHERE clerk_id = $1", [row.clerk_id]);
  }
}

export async function reconcileMemberships(subscriptionId?: string): Promise<void> {
  const client = await pool.connect();
  try {
    // Only one server instance sweeps at a time. This session lock is released
    // even if one subscription or the whole sweep fails.
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(20261001, 56) AS acquired");
    if (!lock.rows[0]?.acquired) return;
    try {
      const stripe = await getUncachableStripeClient();
      let after = "0";
      while (true) {
        const batch = await client.query<{ id: string; stripe_subscription_id: string }>(
          "SELECT id, stripe_subscription_id FROM membership_checkouts WHERE status = 'confirmed' AND stripe_subscription_id IS NOT NULL AND id > $1 AND ($2::text IS NULL OR stripe_subscription_id = $2) ORDER BY id LIMIT 100",
          [after, subscriptionId ?? null],
        );
        if (!batch.rows.length) break;
        for (const row of batch.rows) {
          after = row.id;
          try {
            await client.query("BEGIN");
            await reconcileSubscription(client, row.stripe_subscription_id, stripe);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            logger.error({ err, subscriptionId: row.stripe_subscription_id }, "Membership reconciliation failed");
          }
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(20261001, 56)");
    }
  } finally {
    client.release();
  }
}

export function startMembershipReconciliation(): void {
  const run = () => { void reconcileMemberships().catch(err => logger.error({ err }, "Membership sweep failed")); };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}