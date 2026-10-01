import type { PoolClient } from "@workspace/db";
import { pool } from "@workspace/db";
import type Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";
import { membershipSweepHealth, type SweepFailure } from "./membership-sweep-health";

const SWEEP_INTERVAL_MS = 15 * 60_000;
const MAX_HISTORY_RETRY_MS = 24 * 60 * 60_000;

function historyRetryDelay(attempt: number): number {
  return Math.min(SWEEP_INTERVAL_MS * 2 ** Math.min(attempt - 1, 7), MAX_HISTORY_RETRY_MS);
}

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
    invoice_history_pending: boolean; invoice_history_retry_count: number;
  }>(
    "SELECT id, clerk_id, kind, status, failed_months, last_failed_invoice, invoice_history_pending, invoice_history_retry_count FROM membership_checkouts WHERE stripe_subscription_id = $1 FOR UPDATE",
    [subscriptionId],
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.status === "forfeited" && row.kind === "founding" && row.invoice_history_pending) {
    // No subscription lookup or tier write: this is history repair, never access repair.
    try {
      const failed = await currentFailedBillingMonths(stripe, subscriptionId);
      await client.query(
        "UPDATE membership_checkouts SET failed_months = $2, last_failed_invoice = $3, invoice_history_pending = false, invoice_history_retry_count = 0, invoice_history_retry_at = NULL WHERE id = $1 AND status = 'forfeited' AND invoice_history_pending",
        [row.id, failed.count, failed.lastId],
      );
    } catch (err) {
      const attempt = row.invoice_history_retry_count + 1;
      await client.query(
        "UPDATE membership_checkouts SET invoice_history_retry_count = $2, invoice_history_retry_at = now() + ($3::bigint * interval '1 millisecond') WHERE id = $1 AND status = 'forfeited' AND invoice_history_pending",
        [row.id, attempt, historyRetryDelay(attempt)],
      );
      logger.error({ err, subscriptionId, attempt }, "Ended membership invoice history still unavailable");
    }
    return;
  }
  if (row.status !== "confirmed") return; // A forfeited founding place is permanent.

  let subscription = await stripe.subscriptions.retrieve(subscriptionId);
  let failed = { count: 0, lastId: null as string | null };
  let historyPending = false;
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
        historyPending = true;
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
      "UPDATE membership_checkouts SET status = 'forfeited', failed_months = $2, last_failed_invoice = $3, invoice_history_pending = $4, invoice_history_retry_count = CASE WHEN $4 THEN 1 ELSE 0 END, invoice_history_retry_at = CASE WHEN $4 THEN now() + ($5::bigint * interval '1 millisecond') ELSE NULL END WHERE id = $1 AND status = 'confirmed'",
      [row.id, failed.count, failed.lastId, historyPending, historyRetryDelay(1)],
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
  // Clear only after status/access writes succeed, in the same transaction.
  await client.query("DELETE FROM membership_reconciliation_failures WHERE stripe_subscription_id = $1", [subscriptionId]);
}

export async function unresolvedReconciliationAlerts(): Promise<{
  total: number;
  subscriptionsAvailable: boolean;
  sweepFailure: SweepFailure | null;
  subscriptions: { subscriptionId: string; consecutiveFailures: number; firstFailedAt: string; lastFailedAt: string }[];
}> {
  try {
    const sweepFailure = await membershipSweepHealth.warning();
    const result = await pool.query<{
      subscription_id: string; consecutive_failures: number; first_failed_at: Date; last_failed_at: Date; total: number;
    }>(`SELECT f.stripe_subscription_id AS subscription_id, f.consecutive_failures, f.first_failed_at, f.last_failed_at,
       COUNT(*) OVER ()::int AS total
       FROM membership_reconciliation_failures f
       JOIN membership_checkouts m ON m.stripe_subscription_id = f.stripe_subscription_id
       WHERE m.kind = 'founding' AND m.status = 'confirmed' AND f.consecutive_failures >= 3
       ORDER BY f.last_failed_at DESC, f.stripe_subscription_id LIMIT 100`);
    return {
      total: result.rows[0]?.total ?? 0,
      subscriptionsAvailable: true,
      sweepFailure,
      subscriptions: result.rows.map(row => ({
        subscriptionId: row.subscription_id,
        consecutiveFailures: row.consecutive_failures,
        firstFailedAt: row.first_failed_at.toISOString(),
        lastFailedAt: row.last_failed_at.toISOString(),
      })),
    };
  } catch (err) {
    const sweepFailure = membershipSweepHealth.localWarning();
    if (!sweepFailure) throw err;
    // Do not hide a known prolonged global outage behind the failed database
    // query, or represent unavailable per-subscription checks as healthy.
    return { total: 0, subscriptions: [], subscriptionsAvailable: false, sweepFailure };
  }
}

export async function outstandingReviewNotifications(): Promise<{ id: string; createdAt: string }[]> {
  // Deliberately project only notification metadata, never billing identifiers.
  const result = await pool.query<{ id: string; created_at: Date }>(`
    SELECT f.notification_id::text AS id, f.notified_at AS created_at
    FROM membership_reconciliation_failures f
    JOIN membership_checkouts m ON m.stripe_subscription_id = f.stripe_subscription_id
    WHERE m.kind = 'founding' AND m.status = 'confirmed' AND f.notification_id IS NOT NULL
    ORDER BY f.notified_at DESC, f.notification_id`);
  return result.rows.map(row => ({ id: row.id, createdAt: row.created_at.toISOString() }));
}

let sweepRunning = false;

export async function reconcileMemberships(subscriptionId?: string): Promise<void> {
  if (!subscriptionId && sweepRunning) return;
  if (!subscriptionId) sweepRunning = true;
  let client: PoolClient | undefined;
  let failureRecorded = false;
  try {
    client = await pool.connect();
    // Only one server instance sweeps at a time. This session lock is released
    // even if one subscription or the whole sweep fails.
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(20261001, 56) AS acquired");
    if (!lock.rows[0]?.acquired) return;
    try {
      const stripe = await getUncachableStripeClient();
      let after = "0";
      while (true) {
        const batch = await client.query<{ id: string; kind: string; status: string; stripe_subscription_id: string }>(
          "SELECT id, kind, status, stripe_subscription_id FROM membership_checkouts WHERE (status = 'confirmed' OR (status = 'forfeited' AND kind = 'founding' AND invoice_history_pending AND invoice_history_retry_at <= now())) AND stripe_subscription_id IS NOT NULL AND id > $1 AND ($2::text IS NULL OR stripe_subscription_id = $2) ORDER BY id LIMIT 100",
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
            if (row.kind === "founding" && row.status === "confirmed") {
              try {
                await client.query(`INSERT INTO membership_reconciliation_failures (stripe_subscription_id)
                  VALUES ($1) ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                  consecutive_failures = membership_reconciliation_failures.consecutive_failures + 1,
                  last_failed_at = now(),
                  notification_id = CASE WHEN membership_reconciliation_failures.consecutive_failures + 1 >= 3
                    THEN COALESCE(membership_reconciliation_failures.notification_id, gen_random_uuid())
                    ELSE membership_reconciliation_failures.notification_id END,
                  notified_at = CASE WHEN membership_reconciliation_failures.consecutive_failures + 1 >= 3
                    THEN COALESCE(membership_reconciliation_failures.notified_at, now())
                    ELSE membership_reconciliation_failures.notified_at END`, [row.stripe_subscription_id]);
              } catch (alertError) {
                logger.error({ err: alertError, subscriptionId: row.stripe_subscription_id }, "Could not record membership reconciliation failure");
              }
            }
          }
        }
      }
      if (!subscriptionId) await membershipSweepHealth.healthy(client);
    } catch (err) {
      if (!subscriptionId) {
        await membershipSweepHealth.failed(client);
        failureRecorded = true;
      }
      throw err;
    } finally {
      await client.query("SELECT pg_advisory_unlock(20261001, 56)");
    }
  } catch (err) {
    // Connection/lock failures occur before the inner sweep error handler.
    if (!subscriptionId && !failureRecorded) await membershipSweepHealth.failed(client);
    throw err;
  } finally {
    client?.release();
    if (!subscriptionId) sweepRunning = false;
  }
}

export function startMembershipReconciliation(): void {
  const run = () => { void reconcileMemberships().catch(err => logger.error({ err }, "Membership sweep failed")); };
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}