---
name: Profile cleanup concurrency
description: Why fixture deletion needs an exact database snapshot rather than only ownership or profile version checks.
---

Fixture eligibility is not deletion authorization once another connection can edit the row. Match the exact validated row at deletion and treat a mismatch as a transaction failure before deleting the external identity.

**Why:** A committed profile edit between validation and DELETE was lost despite correct fixture ownership and exact account scoping. A version-only check would also assume that every possible database writer advances the profile version.

**How to apply:** Preserve database precision when comparing snapshots, abort on a deleted-row count mismatch, and leave the Clerk identity available for a safe retry. Concurrency tests need independently connected, explicitly owned development data rather than session-local tables that another connection cannot see.

Database-first fixture deletion needs a second, fenced decision before removing the external identity. If new member data appears in the commit gap, restore the validated profile without overwriting a newly recreated profile and preserve the identity.

**Why:** Database and Clerk deletion are not atomic. Many member-content references are plain identity strings rather than foreign keys, so locking only the profile row cannot protect them. Development-only cleanup accepts a short table-wide write fence through the external call; this tradeoff is not suitable for a normal production member-deletion route.

**How to apply:** Include every identity-bearing table in both the final guard and its fence. Commit compensating restoration before reporting refusal, and verify the commit gap using an independently connected writer that observes the committed deletion.

Pre-deletion safety-check failures need compensation too, not just explicit data conflicts. Keep that compensation independent of external identity lookups and linked-table fences.

**Why:** A failed Clerk lookup or lock acquisition after the database commit can otherwise skip restoration entirely. Once external deletion has actually been attempted, however, restoring could recreate a profile for an identity that was deleted despite an uncertain response.

**How to apply:** Separate failures before the external deletion attempt from uncertain deletion outcomes. Restore known local conflicts before querying Clerk, and test lock timeouts and lookup outages with a second database connection.

Verify remote deletion through the exact Clerk identity endpoint with bounded propagation time, not an immediate list result.

**Why:** A development list response briefly retained a deleted identity with its email addresses already removed, causing an otherwise successful cleanup regression to fail.

**How to apply:** Accept only an explicit not-found response as deletion confirmation; propagate authorization, rate-limit, and other errors rather than treating them as absence.

Do not retroactively authorize abandoned profile checks from their email or display name when adding new recoverable fixture shapes.

**Why:** Older response-order checks were created without private ownership markers, and older UUID prefixes contain hyphens. Their resemblance to newer owned fixtures does not prove they are disposable.

**How to apply:** Fix ownership and tag generation for future runs, keep recognized persisted states narrowly scoped to each scenario, and leave historical unowned accounts for explicit ownership review.

Profile fixture cleanup deliberately refuses any change to the validated Clerk snapshot, even if the edited identity still matches an eligible fixture shape. Make the last exact-ID read immediately precede the deletion attempt, and compensate local deletion when that read changes or fails.

**Why:** An ordinary fixture marker can remain valid while independent ownership metadata or other identity fields change. Clerk's documented [deleteUser](https://clerk.com/docs/reference/backend/user/delete-user) takes only an ID, without an expected revision or documented conditional-delete option. Another read is the strongest available check in this flow, not an atomic guarantee.

**How to apply:** Keep full snapshot equality separate from fixture eligibility; do not replace it with email matching or only a timestamp comparison. Do not claim the remaining remote read/delete gap is eliminated, and keep this policy restricted to development fixtures.