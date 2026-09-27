CREATE TABLE IF NOT EXISTS "radiant_audits" (
  "clerk_id" text PRIMARY KEY REFERENCES "users"("clerk_id"),
  "routine_checks" text[] NOT NULL,
  "values_checks" text[] NOT NULL,
  "beauty_trend" text NOT NULL,
  "mastery_goal" text NOT NULL,
  "research_time" text NOT NULL,
  "completed_at" timestamptz NOT NULL DEFAULT now()
);