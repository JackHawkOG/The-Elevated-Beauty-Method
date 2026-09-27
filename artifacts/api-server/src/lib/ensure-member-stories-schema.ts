import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with lib/db/migrations/0008_member_stories.sql.
export async function ensureMemberStoriesSchema(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "member_stories" (
    "id" serial PRIMARY KEY,
    "quote" text NOT NULL,
    "attribution" text NOT NULL,
    "permission_record" text NOT NULL,
    "permission_recorded_by" text NOT NULL,
    "permission_recorded_at" timestamptz NOT NULL,
    "published_at" timestamptz NOT NULL,
    "withdrawn_at" timestamptz,
    "withdrawn_by" text
  )`);
}