---
name: Shared development schema freshness
description: Why unrelated integration checks can fail after another task merges a schema change.
---

When an isolated test suddenly fails on a missing database column after a concurrent merge, check whether the shared development database is behind the current startup schema before changing the test or product logic.

**Why:** Isolated tests use the same development database but do not necessarily run every application's startup schema step. A task can merge the new column into code before the managed server has restarted to apply it; several unrelated API tests then fail with misleading HTTP errors.

**How to apply:** Confirm the failure is a missing column and that the application's existing startup path adds it. Restart the existing managed API workflow once, inspect its startup logs, and rerun the failed check. Never use this as a reason to change production data or run an unguarded test migration.