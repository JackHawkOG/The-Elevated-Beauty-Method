---
name: Live test database pool lifetime
description: How to avoid disrupting subsequent live browser checks that share a database module
---

Live browser checks in one Playwright worker can reuse a cached database module. A single test should not close that module's shared connection pool as part of its fixture cleanup.

**Why:** Closing the pool after one test can make later tests in the same worker fail even though their own fixtures are correct.

**How to apply:** Clean up only the test-owned rows and remote identities in its `finally` block; let the worker own process-level pool shutdown.