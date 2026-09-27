BEGIN;
-- Block writes while duplicate rows are merged and the constraint is installed.
LOCK TABLE "enrollments" IN SHARE ROW EXCLUSIVE MODE;

-- Keep the earliest enrollment identity and date, but retain the greatest
-- recorded progress and the latest non-null last lesson from duplicate rows.
WITH ranked AS (
  SELECT "id", "user_id", "course_id",
    row_number() OVER (
      PARTITION BY "user_id", "course_id" ORDER BY "enrolled_at", "id"
    ) AS position,
    max("completed_lessons") OVER (
      PARTITION BY "user_id", "course_id"
    ) AS most_completed,
    count(*) OVER (
      PARTITION BY "user_id", "course_id"
    ) AS copies,
    first_value("last_lesson_id") OVER (
      PARTITION BY "user_id", "course_id"
      ORDER BY ("last_lesson_id" IS NULL), "completed_lessons" DESC, "enrolled_at" DESC, "id" DESC
    ) AS latest_lesson
  FROM "enrollments"
)
UPDATE "enrollments" e
SET "completed_lessons" = r.most_completed, "last_lesson_id" = r.latest_lesson
FROM ranked r
WHERE e."id" = r."id" AND r.position = 1 AND r.copies > 1;

DELETE FROM "enrollments" e
USING (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id", "course_id" ORDER BY "enrolled_at", "id"
  ) AS position
  FROM "enrollments"
) r
WHERE e."id" = r."id" AND r.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "enrollments_user_id_course_id_unique"
  ON "enrollments" ("user_id", "course_id");
COMMIT;