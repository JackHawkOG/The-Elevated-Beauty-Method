-- Existing receipts receive a fresh retention window on upgrade.
ALTER TABLE "radiant_audit_submissions"
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS "radiant_audit_submissions_created_at_idx"
  ON "radiant_audit_submissions" ("created_at");