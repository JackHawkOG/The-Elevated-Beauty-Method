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
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS membership_checkouts_clerk_idx ON membership_checkouts(clerk_id)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_webhook_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now())`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS membership_checkout_expirations (
    stripe_session_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}