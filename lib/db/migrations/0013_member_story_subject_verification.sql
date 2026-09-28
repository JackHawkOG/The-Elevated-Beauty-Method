ALTER TABLE member_stories ADD COLUMN IF NOT EXISTS verified_subject_user_id text;
ALTER TABLE member_stories ADD COLUMN IF NOT EXISTS subject_verification_record text;
ALTER TABLE member_stories ADD COLUMN IF NOT EXISTS subject_verified_at timestamptz;
ALTER TABLE member_stories ADD COLUMN IF NOT EXISTS subject_verified_by text;
ALTER TABLE member_stories ADD COLUMN IF NOT EXISTS removal_requester_is_verified_subject boolean;