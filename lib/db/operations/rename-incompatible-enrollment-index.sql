-- MANUAL, OFFLINE OPERATION ONLY. See docs/enrollment-index-recovery.md.
-- Set search_path to exactly the reviewed enrollment schema, with no fallback.
-- Preserve the legacy object and dependencies; never DROP ... CASCADE.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE enrollments IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  target oid := to_regclass('enrollments_user_id_course_id_unique');
  table_oid oid := 'enrollments'::regclass;
BEGIN
  IF target IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indexrelid = target AND x.indrelid = table_oid
      AND n.nspname = current_schema() AND i.relnamespace = t.relnamespace
  ) THEN
    RAISE EXCEPTION 'Expected legacy index on enrollments in the selected schema; inspect before recovery';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index x
    JOIN pg_attribute u ON u.attrelid = x.indrelid AND u.attname = 'user_id'
    JOIN pg_attribute c ON c.attrelid = x.indrelid AND c.attname = 'course_id'
    WHERE x.indexrelid = target
      AND x.indisunique AND x.indisvalid AND x.indisready AND x.indimmediate
      AND x.indnkeyatts = 2 AND x.indpred IS NULL AND x.indexprs IS NULL
      AND x.indkey[0] = u.attnum AND x.indkey[1] = c.attnum
  ) THEN
    RAISE EXCEPTION 'Index already enforces enrollment uniqueness; no rename needed';
  END IF;
  IF to_regclass('enrollments_user_id_course_id_legacy') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = table_oid AND conname = 'enrollments_user_id_course_id_legacy'
  ) THEN
    RAISE EXCEPTION 'Legacy destination name is occupied; inspect before recovery';
  END IF;
  -- PostgreSQL also renames an owning constraint, retaining its OID and FKs.
  EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', current_schema(),
    'enrollments_user_id_course_id_unique', 'enrollments_user_id_course_id_legacy');
END
$$;
COMMIT;