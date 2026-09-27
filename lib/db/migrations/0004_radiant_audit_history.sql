CREATE TABLE IF NOT EXISTS "radiant_audit_history" (
  "id" bigserial PRIMARY KEY,
  "clerk_id" text NOT NULL REFERENCES "users"("clerk_id"),
  "routine_checks" text[] NOT NULL,
  "values_checks" text[] NOT NULL,
  "beauty_trend" text NOT NULL,
  "mastery_goal" text NOT NULL,
  "research_time" text NOT NULL,
  "completed_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "radiant_audit_history_member_idx" ON "radiant_audit_history" ("clerk_id", "id");