---
name: Community fixture ownership
description: Why automated cleanup excludes older community test identities without explicit ownership markers
---

Automated community-check cleanup must not delete pre-marker identities based solely on their email pattern or announcement titles. Those older identities may need human inspection, not a widened automatic deletion rule.

Apply the same rule to course-switch browser checks: older runs without a dedicated marker are review leads, not deletion candidates. A matching email or course title cannot establish ownership of a member account or public course.

**Why:** The test previously created Clerk users without private fixture metadata. An email/name/title match alone cannot prove the account and its content are disposable; deleting real community content is unacceptable.

**How to apply:** Keep cleanup restricted to explicitly marked, aged development fixtures with exact post/activity relationships. If older unmarked leftovers must be addressed, review them individually and establish ownership before removal.