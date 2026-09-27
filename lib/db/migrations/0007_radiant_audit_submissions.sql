CREATE TABLE IF NOT EXISTS "radiant_audit_submissions" (
  "clerk_id" text NOT NULL REFERENCES "users"("clerk_id"),
  "submission_id" uuid NOT NULL,
  "answers" jsonb NOT NULL,
  "result" jsonb,
  PRIMARY KEY ("clerk_id", "submission_id")
);