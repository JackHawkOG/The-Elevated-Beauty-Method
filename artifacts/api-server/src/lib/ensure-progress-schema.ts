import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// The API applies this additive migration before serving requests, including
// deployments with an existing database. The matching SQL is kept in lib/db/migrations.
export async function ensureProgressSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "lesson_completions" (
      "user_id" text NOT NULL,
      "lesson_id" integer NOT NULL REFERENCES "lessons"("id"),
      "completed_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "lesson_completions_user_id_lesson_id_pk" PRIMARY KEY ("user_id", "lesson_id")
    )
  `);
  await db.execute(sql`
    INSERT INTO "lesson_completions" ("user_id", "lesson_id")
    SELECT e."user_id", l."id"
    FROM "enrollments" e
    CROSS JOIN LATERAL (
      SELECT "id" FROM "lessons"
      WHERE "course_id" = e."course_id"
      ORDER BY "sort_order", "id"
      LIMIT e."completed_lessons"
    ) l
    WHERE NOT EXISTS (
      SELECT 1 FROM "lesson_completions" previous WHERE previous."user_id" = e."user_id"
        AND previous."lesson_id" IN (SELECT "id" FROM "lessons" WHERE "course_id" = e."course_id")
    )
    ON CONFLICT DO NOTHING
  `);
}