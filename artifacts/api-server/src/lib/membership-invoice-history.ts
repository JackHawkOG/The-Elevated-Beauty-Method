import { pool } from "@workspace/db";

// Read persisted recovery state only: viewing this queue must never retry Stripe
// requests, alter forfeiture, or grant access.
export async function pendingMembershipInvoiceHistory(after = 0) {
  const result = await pool.query<{
    id: number;
    clerk_id: string;
    stripe_subscription_id: string | null;
    invoice_history_retry_count: number;
    invoice_history_retry_at: Date | null;
  }>(
    `SELECT id, clerk_id, stripe_subscription_id, invoice_history_retry_count, invoice_history_retry_at
     FROM membership_checkouts
     WHERE status = 'forfeited' AND kind = 'founding' AND invoice_history_pending AND id > $1
     ORDER BY id LIMIT 51`,
    [after],
  );
  const page = result.rows.slice(0, 50);
  return {
    memberships: page.map(row => ({
      checkoutId: row.id,
      memberId: row.clerk_id,
      subscriptionId: row.stripe_subscription_id,
      retryAttempts: row.invoice_history_retry_count,
      nextRetryAt: row.invoice_history_retry_at?.toISOString() ?? null,
    })),
    nextCursor: result.rows.length > 50 ? page[page.length - 1].id : null,
  };
}