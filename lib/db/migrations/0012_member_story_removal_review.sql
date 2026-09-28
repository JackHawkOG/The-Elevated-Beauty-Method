ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_review_outcome" text;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_review_note" text;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_reviewed_at" timestamptz;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_reviewed_by" text;