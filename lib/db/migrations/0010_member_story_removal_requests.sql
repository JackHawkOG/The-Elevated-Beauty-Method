ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requested_at" timestamptz;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requested_by" text;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_requester_email" text;
ALTER TABLE "member_stories" ADD COLUMN IF NOT EXISTS "removal_request_note" text;