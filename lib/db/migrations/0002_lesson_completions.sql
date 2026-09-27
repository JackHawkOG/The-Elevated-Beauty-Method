CREATE TABLE IF NOT EXISTS "lesson_completions" (
  "user_id" text NOT NULL,
  "lesson_id" integer NOT NULL REFERENCES "lessons"("id"),
  "completed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lesson_completions_user_id_lesson_id_pk" PRIMARY KEY ("user_id", "lesson_id")
);

-- Preserve existing aggregate progress as individual completions where possible.
-- Historical lesson identities were not saved, so use the first N lessons in order.
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
ON CONFLICT DO NOTHING;