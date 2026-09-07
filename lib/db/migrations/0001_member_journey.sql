ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "membership_tier" text DEFAULT 'Free' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "skin_type" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "undertone" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "feature_needs" text[];
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "life_stage" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "visibility_goal" text;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "access_tier" text DEFAULT 'Elevated' NOT NULL;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "transformation_story" text;