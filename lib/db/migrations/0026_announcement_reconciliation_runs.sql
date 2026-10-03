-- Append-only application archive; retain all outcomes, including empty runs.
-- No source foreign keys or automatic expiry: evidence survives source deletion.
CREATE TABLE IF NOT EXISTS "announcement_reconciliation_runs" (
  "id" serial PRIMARY KEY,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  "repaired_ids" jsonb NOT NULL,
  "review" jsonb NOT NULL
);