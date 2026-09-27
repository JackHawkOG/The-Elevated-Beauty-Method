ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_announcement_id" integer REFERENCES "announcements" ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "activity_source_announcement_unique"
  ON "activity" ("source_announcement_id");