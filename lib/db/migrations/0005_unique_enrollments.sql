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

-- A single legacy enrollment can also point to a draft or another course.
-- Preserve its progress while clearing only an unavailable resume destination.
UPDATE "enrollments" e
SET "last_lesson_id" = NULL
WHERE e."last_lesson_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "lessons" l
    WHERE l."id" = e."last_lesson_id"
      AND l."course_id" = e."course_id"
      AND l."published_at" IS NOT NULL
  );

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
-- IF NOT EXISTS only checks the name; reject a legacy index with an
-- incompatible definition rather than committing a repair without uniqueness.
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
$$;
COMMIT;