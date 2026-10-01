import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with lib/db/migrations/0017_profile_version.sql.
export async function ensureProfileSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_version"
    text NOT NULL DEFAULT gen_random_uuid()::text`);
}