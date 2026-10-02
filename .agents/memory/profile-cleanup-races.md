---
name: Profile cleanup concurrency
description: Why fixture deletion needs an exact database snapshot rather than only ownership or profile version checks.
---

Fixture eligibility is not deletion authorization once another connection can edit the row. Match the exact validated row at deletion and treat a mismatch as a transaction failure before deleting the external identity.

**Why:** A committed profile edit between validation and DELETE was lost despite correct fixture ownership and exact account scoping. A version-only check would also assume that every possible database writer advances the profile version.

**How to apply:** Preserve database precision when comparing snapshots, abort on a deleted-row count mismatch, and leave the Clerk identity available for a safe retry. Concurrency tests need independently connected, explicitly owned development data rather than session-local tables that another connection cannot see.

Verify remote deletion through the exact Clerk identity endpoint with bounded propagation time, not an immediate list result.

**Why:** A development list response briefly retained a deleted identity with its email addresses already removed, causing an otherwise successful cleanup regression to fail.

**How to apply:** Accept only an explicit not-found response as deletion confirmation; propagate authorization, rate-limit, and other errors rather than treating them as absence.