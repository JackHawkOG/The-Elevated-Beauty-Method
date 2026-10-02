CREATE TABLE IF NOT EXISTS "routine_guide_claims" (
  "request_id" uuid PRIMARY KEY,
  "email_hash" text NOT NULL,
  "consent" boolean NOT NULL CHECK ("consent" = true),
  "consent_text" text NOT NULL,
  "guide_version" text NOT NULL,
  "consented_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "routine_guide_claims_email_idx"
  ON "routine_guide_claims" ("email_hash", "created_at");

CREATE TABLE IF NOT EXISTS "routine_guide_deliveries" (
  "guide_version" text NOT NULL,
  "email_hash" text NOT NULL,
  "email" text NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('processing', 'sent', 'failed', 'uncertain')),
  "provider_idempotency_key" text NOT NULL UNIQUE,
  "first_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "lease_until" timestamptz,
  "accepted_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 1 CHECK ("attempt_count" > 0),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("guide_version", "email_hash")
);
CREATE INDEX IF NOT EXISTS "routine_guide_deliveries_state_idx"
  ON "routine_guide_deliveries" ("state", "lease_until");

CREATE TABLE IF NOT EXISTS "routine_guide_rate_limits" (
  "key_hash" text NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  PRIMARY KEY ("key_hash", "window_started_at")
);