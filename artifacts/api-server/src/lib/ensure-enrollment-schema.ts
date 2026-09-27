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
  });
}
