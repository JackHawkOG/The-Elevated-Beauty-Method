-- Offline verification after 0005_unique_enrollments.sql, same search_path.
-- The probe uses an explicit ID: it does not advance the enrollment sequence.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE enrollments IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  member_id text;
  member_course integer;
  probe_id integer;
  rejected_by text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM enrollments GROUP BY user_id, course_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate enrollments remain; keep signups offline';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x
    JOIN pg_attribute u ON u.attrelid = x.indrelid AND u.attname = 'user_id'
    JOIN pg_attribute c ON c.attrelid = x.indrelid AND c.attname = 'course_id'
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE x.indexrelid = to_regclass('enrollments_user_id_course_id_unique')
      AND x.indrelid = 'enrollments'::regclass AND n.nspname = current_schema()
      AND x.indisunique AND x.indisvalid AND x.indisready AND x.indimmediate
      AND x.indnkeyatts = 2 AND x.indpred IS NULL AND x.indexprs IS NULL
      AND x.indkey[0] = u.attnum AND x.indkey[1] = c.attnum
  ) THEN
    RAISE EXCEPTION 'Enrollment uniqueness is not installed; keep signups offline';
  END IF;
  SELECT user_id, course_id INTO member_id, member_course
  FROM enrollments ORDER BY id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No enrollment available for duplicate probe; create an approved test enrollment before verification';
  END IF;
  SELECT (greatest(coalesce(max(id), 0), 0)::bigint + 1)::integer INTO probe_id
  FROM enrollments;
  BEGIN
    INSERT INTO enrollments (id, user_id, course_id, completed_lessons, enrolled_at)
    VALUES (probe_id, member_id, member_course, 0, CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Duplicate probe was accepted; keep signups offline';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS rejected_by = CONSTRAINT_NAME;
    IF rejected_by IS DISTINCT FROM 'enrollments_user_id_course_id_unique' THEN
      RAISE EXCEPTION 'Duplicate probe rejected by unexpected constraint: %', rejected_by;
    END IF;
  END;
  RAISE NOTICE 'Enrollment recovery verified: no duplicates; duplicate probe rejected by the expected index';
END
$$;
-- No probe rows or database trigger writes survive verification.
ROLLBACK;