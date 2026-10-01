ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_version"
  text NOT NULL DEFAULT gen_random_uuid()::text;