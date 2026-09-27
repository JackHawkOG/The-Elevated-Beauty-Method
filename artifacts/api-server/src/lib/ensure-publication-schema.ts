import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Existing rows remain drafts until an approved seed or an owner approval marks them published.
export async function ensurePublicationSchema(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('courses', 'lessons')
      AND column_name = 'published_at'
  `);
  const isLegacy = Number(result.rows[0]?.count) !== 2;
  await db.execute(sql`ALTER TABLE courses ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await db.execute(sql`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  return isLegacy;
}