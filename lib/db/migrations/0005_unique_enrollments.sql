BEGIN;
-- Block writes while duplicate rows are merged and the constraint is installed.
LOCK TABLE "enrollments" IN SHARE ROW EXCLUSIVE MODE;

-- Keep the earliest enrollment identity and date, but retain the greatest
-- recorded progress and the latest available lesson in the enrolled course.
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