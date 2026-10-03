---
name: Community fixture ownership
description: Why automated cleanup excludes older community test identities without explicit ownership markers
---

Automated community-check cleanup must not delete pre-marker identities based solely on their email pattern or announcement titles. Those older identities may need human inspection, not a widened automatic deletion rule.

Apply the same rule to course-switch browser checks: older runs without a dedicated marker are review leads, not deletion candidates. A matching email or course title cannot establish ownership of a member account or public course.

**Why:** The test previously created Clerk users without private fixture metadata. An email/name/title match alone cannot prove the account and its content are disposable; deleting real community content is unacceptable.

**How to apply:** Keep cleanup restricted to explicitly marked, aged development fixtures with exact post/activity relationships. If older unmarked leftovers must be addressed, review them individually and establish ownership before removal.

A missing normal fixture marker does not necessarily mean all ownership evidence
is absent. An independent private integration-run marker can establish ownership
after reviewing the test that wrote it. Treat that as an exact-account manual
review, not permission to widen email-pattern cleanup.

**Why:** Negative cleanup tests intentionally create identities without the normal
marker while still recording private run ownership; their leftovers can otherwise
be mistaken for unverifiable legacy member accounts.

**How to apply:** Verify the independent evidence, recheck it before removal,
and refuse removal when linked member data exists or the evidence changes.

Independent profile cleanup integration ownership may also authorize a separate
opt-in recovery, but only for a supplied run UUID and exact identity IDs. It must
not widen the ordinary discovery rules; reject extra or conflicting private
ownership, changed fixture shapes, young accounts, and linked member data.

**Why:** Interrupted negative tests deliberately lack the normal fixture marker
while retaining independent run ownership. Treating email patterns as ownership
would put unrelated accounts at risk.

**How to apply:** Recheck independent ownership through the same database
snapshot and external-deletion fence as ordinary cleanup. Recovery must never
enumerate identities or assume lookup failures mean an account is absent.