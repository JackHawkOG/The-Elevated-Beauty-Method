import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { approvedTopicLessons } from "./approved-topic-lessons";

// Existing rows remain drafts until an approved seed or an owner approval marks them published.
export async function ensurePublicationSchema(database: Pick<typeof db, "transaction"> = db): Promise<boolean> {
  return database.transaction(async tx => {
    // Serialize first-time identity backfill with schema changes across servers.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('publication-schema'))`);
    const result = await tx.execute(sql`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('courses', 'lessons')
        AND column_name = 'published_at'
    `);
    const isLegacy = Number(result.rows[0]?.count) !== 2;
    const identityColumn = await tx.execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'courses' AND column_name = 'approved_topic_key'
    `);
    await tx.execute(sql`ALTER TABLE courses ADD COLUMN IF NOT EXISTS published_at timestamptz`);
    await tx.execute(sql`ALTER TABLE lessons ADD COLUMN IF NOT EXISTS published_at timestamptz`);
    await tx.execute(sql`ALTER TABLE courses ADD COLUMN IF NOT EXISTS approved_topic_key text`);
    // Persist legacy identity before any subsequent rename or lesson-copy edits.
    // Lesson titles also recover courses already renamed before this migration.
    const legacyTopics = identityColumn.rows.length ? [] : approvedTopicLessons;
    // The course's own review title takes precedence over any extra lesson rows.
    for (const topic of legacyTopics) {
      await tx.execute(sql`
        UPDATE courses SET approved_topic_key = ${topic.title}
        WHERE approved_topic_key IS NULL AND title = ${topic.title}
      `);
    }
    for (const topic of legacyTopics) {
      await tx.execute(sql`
        UPDATE courses c SET approved_topic_key = ${topic.title}
        WHERE c.approved_topic_key IS NULL AND EXISTS (
          SELECT 1 FROM lessons l WHERE l.course_id = c.id AND l.title = ${topic.title}
        )
      `);
    }
    return isLegacy;
  });
}