ALTER TABLE membership_checkouts
  ADD COLUMN IF NOT EXISTS conversion_claimed boolean NOT NULL DEFAULT false;