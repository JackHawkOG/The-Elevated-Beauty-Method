---
name: Clerk development API budgets
description: Scoped live fixture checks can exhaust development Clerk listing budgets and obscure the actual regression.
---

Budget and pace repeated development Clerk reads, including verification and teardown. Treat a rate-limit response as an API failure, never as proof that a fixture no longer exists.

**Why:** Repeated exact-ID user-list snapshots hit HTTP 429 in a live cleanup integration run within about ten seconds. A teardown verification failure initially obscured the underlying cleanup defect.

**How to apply:** For live fixture tests, keep remote lookups scoped to disposable IDs, minimize repeated listing, retry rate limits with bounded waits, and attempt cleanup independently for every owned fixture. Preserve the original assertion failure when reporting teardown failures.