import { db, radiantAuditDraftsTable, radiantAuditSubmissionsTable } from "@workspace/db";
import { lt, lte, sql } from "drizzle-orm";
import { logger } from "./logger";

// Seven days covers delayed reconnects and lost responses without keeping answer
// snapshots indefinitely. This bounds receipts, not the member's Audit/history.
export const AUDIT_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function purgeExpiredRadiantAuditReceipts(now = new Date()): Promise<void> {
  await db.delete(radiantAuditSubmissionsTable)
    .where(lt(radiantAuditSubmissionsTable.createdAt, new Date(now.getTime() - AUDIT_RECEIPT_RETENTION_MS)));
}

export function startRadiantAuditReceiptCleanup(): void {
  // Schedule the next run only after the previous one completes.
  const schedule = () => {
    const timer = setTimeout(() => {
      void purgeExpiredRadiantAuditReceipts()
        .catch(err => logger.error({ err }, "Audit receipt cleanup failed"))
        .finally(schedule);
    }, CLEANUP_INTERVAL_MS);
    timer.unref();
  };
  schedule();
}

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
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "radiant_audit_submissions" (
      "clerk_id" text NOT NULL REFERENCES "users"("clerk_id"),
      "submission_id" uuid NOT NULL,
      "answers" jsonb NOT NULL,
      "result" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("clerk_id", "submission_id")
    )
  `);
  // Existing receipts have no creation timestamp. Give them a fresh seven-day
  // grace period on upgrade instead of deleting them immediately.
  await db.execute(sql`ALTER TABLE "radiant_audit_submissions" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "radiant_audit_submissions_created_at_idx" ON "radiant_audit_submissions" ("created_at")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "radiant_audit_drafts" (
      "clerk_id" text PRIMARY KEY REFERENCES "users"("clerk_id"),
      "answers" jsonb NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE "radiant_audit_drafts" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "radiant_audit_drafts_expiry_idx" ON "radiant_audit_drafts" ("expires_at")`);
  await db.execute(sql`DELETE FROM "radiant_audit_drafts" WHERE "expires_at" <= now()`);
  await purgeExpiredRadiantAuditReceipts();
}

export function startRadiantAuditDraftPruning(): void {
  const timer = setInterval(() => {
    void db.delete(radiantAuditDraftsTable)
      .where(lte(radiantAuditDraftsTable.expiresAt, new Date()))
      .catch(err => logger.error({ err }, "Unable to prune expired Audit drafts"));
  }, 60 * 60 * 1000);
  timer.unref();
}
