import { ReplitConnectors } from "@replit/connectors-sdk";
import { clerkClient } from "@clerk/express";
import { pool, type PoolClient } from "@workspace/db";
import { logger } from "./logger";

// Stop before Resend's 24-hour idempotency retention expires, including a
// margin for clock skew and network delays. Never rotate a key after ambiguity.
const SAFE_RETRY_MS = 23 * 60 * 60_000;
const connectors = new ReplitConnectors();
export type ReviewEmailOutcome = "accepted" | "failed";
export type OwnerRecipient = { email: string } | null;

export function membershipReviewUrl(): string | null {
  try {
    const url = new URL(process.env.BILLING_REVIEW_APP_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return new URL("/membership", url.origin).href;
  } catch { return null; }
}

export async function ownerRecipient(clerkId: string): Promise<OwnerRecipient> {
  const user = await clerkClient.users.getUser(clerkId);
  if (user.publicMetadata.role !== "owner") return null;
  const primary = user.emailAddresses.find(address => address.id === user.primaryEmailAddressId);
  return primary?.verification?.status === "verified" ? { email: primary.emailAddress } : null;
}

export function createReviewEmailSender(proxy: typeof connectors.proxy = connectors.proxy.bind(connectors)) {
  return async (email: string, reviewUrl: string, key: string): Promise<ReviewEmailOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        proxy("resend", "/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: {
            from: "The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>",
            to: [email],
            subject: "Membership review service needs attention",
            text: `The membership review service has repeatedly been unable to complete a billing review. This is a service outage, not evidence of a member payment problem.\n\nSign in as the owner to review the private notice:\n${reviewUrl}\n\nYou opted into these operational emails. You can turn them off on the membership page.`,
          },
        }).then(async response => {
          await response.text();
          return response.ok ? "accepted" as const : "failed" as const;
        }),
        new Promise<ReviewEmailOutcome>(resolve => {
          timer = setTimeout(() => resolve("failed"), 20_000);
          timer.unref?.();
        }),
      ]);
    } catch { return "failed"; }
    finally { if (timer) clearTimeout(timer); }
  };
}

// Both preference changes and workers use this lock. A worker persists its
// immutable payload before contacting Resend so a process crash is retryable.
export async function lockReviewEmail(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(20261002, 310)");
}

type Delivery = {
  id: string; notification_id: string; clerk_id: string;
  recipient: string | null; review_url: string | null;
  first_attempt_at: Date | null; attempts: number;
};

async function activeSource(client: PoolClient, notificationId: string): Promise<boolean> {
  // Hold the source row through the send. Recovery deleting that row must
  // commit either before this check (no send) or after dispatch has begun.
  const failure = await client.query(`SELECT f.notification_id
    FROM membership_reconciliation_failures f JOIN membership_checkouts m
    ON m.stripe_subscription_id = f.stripe_subscription_id
    WHERE f.notification_id = $1 AND m.kind = 'founding' AND m.status = 'confirmed'
    FOR SHARE OF f, m`, [notificationId]);
  if (failure.rows.length) return true;
  const sweep = await client.query(`SELECT notification_id FROM membership_sweep_health
    WHERE notification_id = $1 AND consecutive_failures >= 3
    AND last_failed_at - first_failed_at >= interval '30 minutes' FOR SHARE`, [notificationId]);
  return sweep.rows.length > 0;
}

export async function deliverMembershipReviewEmails(dependencies: {
  send?: ReturnType<typeof createReviewEmailSender>;
  recipient?: typeof ownerRecipient;
  reviewUrl?: string | null;
  connect?: () => Promise<PoolClient>;
} = {}): Promise<void> {
  const reviewUrl = dependencies.reviewUrl ?? membershipReviewUrl();
  if (!reviewUrl) return;
  const recipient = dependencies.recipient ?? ownerRecipient;
  const send = dependencies.send ?? createReviewEmailSender();
  const client = await (dependencies.connect ? dependencies.connect() : pool.connect());
  try {
    // Cross-instance worker lock; no second pooled connection is held or needed.
    const locked = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(20261002, 311) AS acquired");
    if (!locked.rows[0]?.acquired) return;
    try {
      await client.query(`INSERT INTO membership_review_email_deliveries (notification_id, clerk_id)
        SELECT source.notification_id, p.clerk_id FROM (
          SELECT f.notification_id FROM membership_reconciliation_failures f
          JOIN membership_checkouts m ON m.stripe_subscription_id = f.stripe_subscription_id
          WHERE f.notification_id IS NOT NULL AND m.kind = 'founding' AND m.status = 'confirmed'
          UNION ALL SELECT notification_id FROM membership_sweep_health
          WHERE consecutive_failures >= 3 AND last_failed_at - first_failed_at >= interval '30 minutes'
        ) source CROSS JOIN membership_review_email_preferences p WHERE p.enabled
        ON CONFLICT (notification_id, clerk_id) DO NOTHING`);
      const pending = await client.query<Delivery>(`SELECT * FROM membership_review_email_deliveries
        WHERE status = 'pending' AND retry_at <= now() ORDER BY retry_at, id LIMIT 100`);
      for (const delivery of pending.rows) {
        try {
          await client.query("BEGIN");
          await lockReviewEmail(client);
          const preference = await client.query("SELECT clerk_id FROM membership_review_email_preferences WHERE clerk_id = $1 AND enabled", [delivery.clerk_id]);
          if (!preference.rows.length || !(await activeSource(client, delivery.notification_id))) {
            await client.query("UPDATE membership_review_email_deliveries SET status = 'suppressed', recipient = NULL, review_url = NULL WHERE id = $1", [delivery.id]);
            await client.query("COMMIT");
            continue;
          }
          const owner = await recipient(delivery.clerk_id);
          if (!owner || (delivery.recipient && delivery.recipient !== owner.email)) {
            await client.query("UPDATE membership_review_email_deliveries SET status = 'suppressed', recipient = NULL, review_url = NULL WHERE id = $1", [delivery.id]);
            await client.query("COMMIT");
            continue;
          }
          if (delivery.first_attempt_at && Date.now() - delivery.first_attempt_at.getTime() >= SAFE_RETRY_MS) {
            await client.query("UPDATE membership_review_email_deliveries SET status = 'uncertain', recipient = NULL, review_url = NULL WHERE id = $1", [delivery.id]);
            await client.query("COMMIT");
            continue;
          }
          const prepared = await client.query<Delivery>(`UPDATE membership_review_email_deliveries SET
            recipient = COALESCE(recipient, $2), review_url = COALESCE(review_url, $3),
            first_attempt_at = COALESCE(first_attempt_at, now()), attempts = attempts + 1,
            retry_at = now() + interval '5 minutes' WHERE id = $1 RETURNING *`,
          [delivery.id, owner.email, reviewUrl]);
          await client.query("COMMIT");
          // Recheck after the durable preparation; recovery/opt-out may have
          // committed in the gap. No external send occurs before this check.
          await client.query("BEGIN");
          await lockReviewEmail(client);
          const enabled = await client.query("SELECT clerk_id FROM membership_review_email_preferences WHERE clerk_id = $1 AND enabled", [delivery.clerk_id]);
          if (!enabled.rows.length || !(await activeSource(client, delivery.notification_id))) {
            await client.query("UPDATE membership_review_email_deliveries SET status = 'suppressed', recipient = NULL, review_url = NULL WHERE id = $1", [delivery.id]);
          } else {
            const row = prepared.rows[0]!;
            if (Date.now() - row.first_attempt_at!.getTime() >= SAFE_RETRY_MS) {
              await client.query("UPDATE membership_review_email_deliveries SET status = 'uncertain', recipient = NULL, review_url = NULL WHERE id = $1", [row.id]);
            } else if (await send(row.recipient!, row.review_url!, `membership-review/${row.id}`) === "accepted") {
              await client.query("UPDATE membership_review_email_deliveries SET status = 'sent', recipient = NULL, review_url = NULL WHERE id = $1", [row.id]);
            }
          }
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK");
          // Do not log provider responses or recipient identities.
          logger.warn("Owner review email attempt could not complete; durable retry retained");
          await client.query("UPDATE membership_review_email_deliveries SET retry_at = now() + interval '5 minutes' WHERE id = $1 AND status = 'pending'", [delivery.id]);
        }
      }
    } finally { await client.query("SELECT pg_advisory_unlock(20261002, 311)"); }
  } finally { client.release(); }
}

export function startMembershipReviewEmails(): void {
  // Development must not send operational alerts about disposable fixtures.
  if (process.env.NODE_ENV !== "production") return;
  const run = () => { void deliverMembershipReviewEmails().catch(() => logger.warn("Owner review email queue unavailable")); };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
}