import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with the member story migrations (0008, 0010, 0012, 0013).
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
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requested_at" timestamptz`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requested_by" text`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requester_email" text`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_request_note" text`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_review_outcome" text`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_review_note" text`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_reviewed_at" timestamptz`);
  await db.execute(sql`ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_reviewed_by" text`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "member_story_review_corrections" (
    "id" serial PRIMARY KEY,
    "story_id" integer NOT NULL REFERENCES "member_stories"("id") ON DELETE CASCADE,
    "outcome" text NOT NULL,
    "note" text NOT NULL,
    "reviewed_at" timestamptz NOT NULL DEFAULT now(),
    "reviewed_by" text NOT NULL
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "member_story_review_corrections_story_id_id_idx"
    ON "member_story_review_corrections" ("story_id", "id")`);
}