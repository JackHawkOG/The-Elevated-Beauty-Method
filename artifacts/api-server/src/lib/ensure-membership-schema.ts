import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function ensureMembershipSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS membership_checkouts (
      id bigserial PRIMARY KEY,
      clerk_id text NOT NULL REFERENCES users(clerk_id),
      kind text NOT NULL CHECK (kind IN ('founding', 'standard')),
      status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired', 'forfeited')),
      stripe_session_id text UNIQUE,
      stripe_subscription_id text UNIQUE,
      stripe_customer_id text,
      failed_months integer NOT NULL DEFAULT 0,
      last_failed_invoice text,
      invoice_history_pending boolean NOT NULL DEFAULT false,
      invoice_history_retry_count integer NOT NULL DEFAULT 0,
      invoice_history_retry_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE membership_checkouts ADD COLUMN IF NOT EXISTS invoice_history_pending boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE membership_checkouts ADD COLUMN IF NOT EXISTS invoice_history_retry_count integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE membership_checkouts ADD COLUMN IF NOT EXISTS invoice_history_retry_at timestamptz`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS membership_checkouts_clerk_idx ON membership_checkouts(clerk_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS membership_invoice_history_retry_idx ON membership_checkouts(invoice_history_retry_at, id) WHERE status = 'forfeited' AND invoice_history_pending`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_webhook_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now())`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_checkout_expirations (
    stripe_session_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS membership_checkout_expirations_age_idx ON membership_checkout_expirations(created_at)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_reconciliation_failures (
    stripe_subscription_id text PRIMARY KEY,
    consecutive_failures integer NOT NULL DEFAULT 1,
    first_failed_at timestamptz NOT NULL DEFAULT now(),
    last_failed_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_sweep_health (
    id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
    consecutive_failures integer NOT NULL,
    first_failed_at timestamptz NOT NULL,
    last_failed_at timestamptz NOT NULL
  )`);
  await db.execute(sql`ALTER TABLE membership_reconciliation_failures ADD COLUMN IF NOT EXISTS notification_id uuid`);
  await db.execute(sql`ALTER TABLE membership_reconciliation_failures ADD COLUMN IF NOT EXISTS notified_at timestamptz`);
  await db.execute(sql`ALTER TABLE membership_sweep_health ADD COLUMN IF NOT EXISTS notification_id uuid NOT NULL DEFAULT gen_random_uuid()`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_review_email_preferences (
    clerk_id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_review_email_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id uuid NOT NULL,
    clerk_id text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'suppressed', 'uncertain')),
    recipient text,
    review_url text,
    first_attempt_at timestamptz,
    retry_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    UNIQUE(notification_id, clerk_id)
  )`);
  // Existing persistent outages also need a notice after this upgrade.
  await db.execute(sql`UPDATE membership_reconciliation_failures
    SET notification_id = gen_random_uuid(), notified_at = now()
    WHERE consecutive_failures >= 3 AND notification_id IS NULL`);
}
