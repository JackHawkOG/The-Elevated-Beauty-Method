CREATE TABLE IF NOT EXISTS "member_story_review_corrections" (
  "id" serial PRIMARY KEY,
  "story_id" integer NOT NULL REFERENCES "member_stories"("id") ON DELETE CASCADE,
  "outcome" text NOT NULL,
  "note" text NOT NULL,
  "reviewed_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_by" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "member_story_review_corrections_story_id_id_idx"
  ON "member_story_review_corrections" ("story_id", "id");