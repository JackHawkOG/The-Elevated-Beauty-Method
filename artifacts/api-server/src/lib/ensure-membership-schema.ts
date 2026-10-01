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
}
