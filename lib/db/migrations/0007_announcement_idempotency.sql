ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "actor_id" text;
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "request_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "announcements_actor_request_unique"
  ON "announcements" ("actor_id", "request_key");