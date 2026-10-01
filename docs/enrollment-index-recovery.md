# Recover signups blocked by a legacy enrollment index

Use this procedure only when startup or migration reports:
`enrollments_user_id_course_id_unique does not enforce enrollment uniqueness`.
This is a deliberate operator operation, not an automatic startup fix.

## 1. Keep enrollment offline and prepare a rollback

- Stop all API instances, enrollment writers, background jobs and deployment
  restarts against the affected database. A table lock protects each operation,
  but **does not protect the intervals between these steps**.
- Confirm the database, environment and enrollment schema with the database
  owner. Do not run workspace tests against production or use workspace public
  enrollment data as a fixture.
- Take a restorable database backup and schema export; retain the index,
  constraints, dependency definitions and enrollment rows before the merge.
  The merge deletes duplicate identities. Restoring the old index name alone
  cannot undo the merge; recovering original data requires the backup.
- Review triggers too. The verification probe rolls back database writes, but
  cannot undo external effects caused by triggers.

Open an operator-approved PostgreSQL connection using your normal secure
connection method. Do not paste credentials into commands, tickets or logs.
From the repository root, in `psql`:

```sql
\set ON_ERROR_STOP on
-- Replace public with the schema you explicitly reviewed.
\set enrollment_schema public
SET search_path TO :"enrollment_schema";
SELECT current_database(), current_schema();
\i lib/db/operations/inspect-enrollment-index.sql
```

Keep the search path limited to that one schema; do not add a public fallback.
If the expected tables or index are missing, or the index belongs to another
table, stop and have the database owner resolve the discrepancy.

## 2. Inspect ownership, dependencies and duplicate identities

The inspection script prints the index definition and status, owning
constraints, foreign keys using the index, dependencies in **both directions**,
all foreign keys referencing enrollments, and duplicate user/course groups.
Inspect the earliest enrollment by `enrolled_at, id` in each duplicate group
(the smallest ID printed is only a locator, not necessarily the survivor).

Do **not** use `DROP INDEX ... CASCADE`, drop an owning constraint, disable
foreign keys, or delete rows manually to get startup past the error. An index
backing a unique or primary-key constraint can support unrelated foreign keys.
Keep those constraints and their semantics.

If any dependent rows reference a duplicate identity that the merge would
delete, stop. Have the database owner separately plan and approve how those
references should be preserved or reassigned, including reviewing ON DELETE
actions (CASCADE could otherwise erase data). This procedure does not rewrite
dependent application data. Rehearse on a restored, isolated copy first.

## 3. Free the expected name without dropping dependencies

After approval, in the same offline session:

```sql
\i lib/db/operations/rename-incompatible-enrollment-index.sql
```

The transaction locks enrollments, refuses a compatible index, missing/wrong
target, or occupied destination, and renames only the reviewed index to
`enrollments_user_id_course_id_legacy`. It does not drop any object. PostgreSQL
also renames an owning constraint; its OID, definition and foreign-key
dependencies remain intact. Review integrations that depend on constraint names.
Keep the legacy object after recovery; retiring it is a separate reviewed change.

If this fails, issue `ROLLBACK;`, inspect again, and keep enrollment offline.
Never overwrite an existing legacy destination to retry.

## 4. Re-run the real merge and verify before resuming

Still with all writers offline and the same schema selected:

```sql
\i lib/db/migrations/0005_unique_enrollments.sql
\i lib/db/operations/verify-enrollment-index-recovery.sql
```

Run these scripts separately with `ON_ERROR_STOP` enabled; do not wrap them in
another transaction (each manages its own transaction). The migration retains
the earliest enrollment/date, greatest recorded progress and usable published
lesson in that course, removes duplicate copies, and creates and validates the
correct unique user/course index. It rolls back its data changes on failure.
Startup repair uses the same merge rules, but do not rely on restarting a live
API as the operator's verification step.

Verification locks the table, checks for remaining duplicates and the actual
index definition, then tries a duplicate of an existing pair with an unused
explicit ID. It must receive SQLSTATE `23505` **from the expected index**; a
different constraint failure is not success. The probe is rolled back and does
not advance the enrollment sequence. Success prints:
`Enrollment recovery verified: no duplicates; duplicate probe rejected by the expected index`.

If the table is empty, create an approved disposable enrollment through your
normal database-owner process (valid member/course and any additional legacy
requirements), run verification, then remove only that disposable enrollment.
An exhausted integer ID range, custom constraint or trigger failure requires
operator review, not bypassing verification.

Compare post-merge survivors/progress with the pre-merge export and confirm
the legacy constraint definitions and dependency OIDs remain unchanged (except
the owning constraint's name). Only then restart the API, confirm startup
repair succeeds, and reopen signups. Never resume after just the rename.

## Failure and retry

The rename and merge are deliberately separate transactions. If the migration
fails after the rename, the legacy object remains under its new name, the
merge rolls back, and signups must stay offline. Issue `ROLLBACK;` on the failed
session, resolve the cause with the database owner, then rerun **the migration
and verification**, not the rename. If verification fails after a committed
merge, keep service offline and investigate; verification itself makes no
lasting row changes.

To abandon recovery **before** a successful merge, the owner can rename the
legacy object back only after confirming the expected name is free. After a
successful merge, do not drop the new index to roll back. Use the reviewed
backup/restore plan with writers still stopped.

## Isolated regression checks

`enrollment-index-recovery.test.ts` exercises these operator SQL files and both
the real migration and startup repair in randomly named private legacy schemas
with no public search-path fallback. It covers standalone and constraint-owned
indexes, dependent foreign keys, refused unsafe retries, merge rollback and
the duplicate-insert gate. Run in the development workspace:

```sh
pnpm exec vitest run artifacts/api-server/src/routes/enrollment-index-recovery.test.ts --maxWorkers=1
```