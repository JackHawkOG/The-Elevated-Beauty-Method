import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Apply this additive table on existing databases before accepting Audit submissions.
// Keep the matching migration in lib/db/migrations for manual schema management.
export async function ensureRadiantAuditSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "radiant_audits" (
      "clerk_id" text PRIMARY KEY REFERENCES "users"("clerk_id"),
      "routine_checks" text[] NOT NULL,
      "values_checks" text[] NOT NULL,
      "beauty_trend" text NOT NULL,
      "mastery_goal" text NOT NULL,
      "research_time" text NOT NULL,
      "completed_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "radiant_audit_history" (
      "id" bigserial PRIMARY KEY,
      "clerk_id" text NOT NULL REFERENCES "users"("clerk_id"),
      "routine_checks" text[] NOT NULL,
      "values_checks" text[] NOT NULL,
      "beauty_trend" text NOT NULL,
      "mastery_goal" text NOT NULL,
      "research_time" text NOT NULL,
      "completed_at" timestamptz NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "radiant_audit_history_member_idx" ON "radiant_audit_history" ("clerk_id", "id")`);
}