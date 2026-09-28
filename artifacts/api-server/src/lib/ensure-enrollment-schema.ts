import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Keep in sync with lib/db/migrations/0005_unique_enrollments.sql. Run before
// accepting requests so old databases are repaired before concurrent inserts.
export async function ensureEnrollmentSchema(database: Pick<typeof db, "transaction"> = db): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE "enrollments" IN SHARE ROW EXCLUSIVE MODE`);
    await tx.execute(sql`
      WITH ranked AS (
        SELECT e."id", e."user_id", e."course_id",
          row_number() OVER (
            PARTITION BY e."user_id", e."course_id" ORDER BY e."enrolled_at", e."id"
          ) AS position,
          max(e."completed_lessons") OVER (
            PARTITION BY e."user_id", e."course_id"
          ) AS most_completed,
          count(*) OVER (
            PARTITION BY e."user_id", e."course_id"
          ) AS copies,
          first_value(l."id") OVER (
            PARTITION BY e."user_id", e."course_id"
            ORDER BY (l."id" IS NULL), e."completed_lessons" DESC, e."enrolled_at" DESC, e."id" DESC
          ) AS latest_lesson
        FROM "enrollments" e
        LEFT JOIN "lessons" l ON l."id" = e."last_lesson_id"
          AND l."course_id" = e."course_id" AND l."published_at" IS NOT NULL
      )
      UPDATE "enrollments" e
      SET "completed_lessons" = r.most_completed, "last_lesson_id" = r.latest_lesson
      FROM ranked r
      WHERE e."id" = r."id" AND r.position = 1 AND r.copies > 1
    `);
    await tx.execute(sql`
      DELETE FROM "enrollments" e
      USING (
        SELECT "id", row_number() OVER (
          PARTITION BY "user_id", "course_id" ORDER BY "enrolled_at", "id"
        ) AS position
        FROM "enrollments"
      ) r
      WHERE e."id" = r."id" AND r.position > 1
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "enrollments_user_id_course_id_unique"
        ON "enrollments" ("user_id", "course_id")
    `);
    // IF NOT EXISTS checks the name, not the index definition. Refuse to
    // commit the merge if a legacy index with that name does not protect pairs.
    await tx.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_index x
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_attribute u ON u.attrelid = x.indrelid AND u.attname = 'user_id'
          JOIN pg_attribute c ON c.attrelid = x.indrelid AND c.attname = 'course_id'
          WHERE i.oid = to_regclass('enrollments_user_id_course_id_unique')
            AND x.indrelid = 'enrollments'::regclass
            AND x.indisunique AND x.indisvalid AND x.indisready AND x.indimmediate
            AND x.indnkeyatts = 2 AND x.indpred IS NULL AND x.indexprs IS NULL
            AND x.indkey[0] = u.attnum AND x.indkey[1] = c.attnum
        ) THEN
          RAISE EXCEPTION 'enrollments_user_id_course_id_unique does not enforce enrollment uniqueness';
        END IF;
      END
      $$
    `);
  });
}
