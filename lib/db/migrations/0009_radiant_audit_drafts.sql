CREATE TABLE IF NOT EXISTS "radiant_audit_drafts" (
  "clerk_id" text PRIMARY KEY REFERENCES "users"("clerk_id"),
  "answers" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "radiant_audit_drafts" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS "radiant_audit_drafts_expiry_idx" ON "radiant_audit_drafts" ("expires_at");
DELETE FROM "radiant_audit_drafts" WHERE "expires_at" <= now();