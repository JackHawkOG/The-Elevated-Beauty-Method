import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with lib/db/migrations/0007_announcement_idempotency.sql.
export async function ensureAnnouncementSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "actor_id" text`);
  await db.execute(sql`ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "request_key" text`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "announcements_actor_request_unique"
    ON "announcements" ("actor_id", "request_key")`);
}