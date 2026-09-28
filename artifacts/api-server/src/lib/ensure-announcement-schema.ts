import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with lib/db/migrations/0007_announcement_idempotency.sql
// and lib/db/migrations/0011_announcement_activity_source.sql.
export async function ensureAnnouncementSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "actor_id" text`);
  await db.execute(sql`ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "request_key" text`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "announcements_actor_request_unique"
    ON "announcements" ("actor_id", "request_key")`);
  await db.execute(sql`ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_announcement_id" integer REFERENCES "announcements" ("id")`);
  await db.execute(sql`ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_evidence" text`);
  await db.execute(sql`ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_reviewed_by" text`);
  await db.execute(sql`ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_reviewed_at" timestamp`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "activity_source_announcement_unique"
    ON "activity" ("source_announcement_id")`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "announcement_activity_corrections" (
    "id" serial PRIMARY KEY,
    "activity_id" integer NOT NULL REFERENCES "activity" ("id") ON DELETE CASCADE,
    "from_announcement_id" integer REFERENCES "announcements" ("id"),
    "to_announcement_id" integer REFERENCES "announcements" ("id"),
    "previous_evidence" text,
    "previous_reviewed_by" text,
    "previous_reviewed_at" timestamp,
    "evidence" text,
    "rationale" text NOT NULL,
    "corrected_by" text NOT NULL,
    "corrected_at" timestamp NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "announcement_activity_corrections_activity_idx"
    ON "announcement_activity_corrections" ("activity_id")`);
}