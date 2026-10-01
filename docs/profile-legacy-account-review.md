# Older profile-check account review

Reviewed the development environment on 2026-10-01.

## Ownership evidence

The existing cleanup dry run listed two aged identities without the normal
profile fixture marker. Both had a separate private cleanup-integration run
marker, with the same run identifier and no other private, public, or unsafe
metadata. The integration test writes that marker when it creates disposable
identities, including its intentionally unmarked negative-test accounts.
This established ownership independently of their matching email/name patterns.
Neither identity had an external account or external identity identifier.

## Removal and safeguards

- Removed only those two exact development Clerk identities.
- Required the existing development Clerk/database guard before inspection and
  again before each deletion; no production environment was accessed.
- Rechecked the private ownership marker and aged fixture shape immediately
  before deletion.
- Checked both identities for local users, enrollments, lesson completions,
  announcements, story subject/reviewer references, activity reviewer references,
  announcement/story review corrections, membership checkouts, and all Audit
  draft/current/history/submission records. No linked rows existed.
- Held database share locks during the final checks and deletion to prevent
  concurrent member writes from invalidating that finding.
- No development user rows or other database records needed removal or were
  changed.

## Verification

Both deleted identities returned Clerk's not-found response after removal.
All four separately listed marked identities outside this review still existed.
The ordinary cleanup eligibility rules were not changed: an email/name match
alone remains insufficient evidence for deletion.

The one-time exact-ID execution script was removed after verification. This
report deliberately omits account identifiers, addresses, and run identifiers.