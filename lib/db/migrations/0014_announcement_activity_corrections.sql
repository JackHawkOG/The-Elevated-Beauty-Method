CREATE TABLE IF NOT EXISTS "announcement_activity_corrections" (
  "id" serial PRIMARY KEY,
  "activity_id" integer NOT NULL REFERENCES "activity" ("id") ON DELETE CASCADE,
  "from_announcement_id" integer REFERENCES "announcements" ("id"),
  "to_announcement_id" integer REFERENCES "announcements" ("id"),
  "previous_evidence" text,
  "previous_reviewed_by" text,
  "previous_reviewed_at" timestamp,
  "evidence" text,
  "rationale" text NOT NULL,
  "corrected_by" text NOT NULL,
  "corrected_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "announcement_activity_corrections_activity_idx"
  ON "announcement_activity_corrections" ("activity_id");