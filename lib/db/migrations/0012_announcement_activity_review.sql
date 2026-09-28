ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_evidence" text;
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_reviewed_by" text;
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "source_reviewed_at" timestamp;