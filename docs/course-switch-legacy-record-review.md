# Older course-switch check record review

Reviewed development on 2026-10-02. No production access and no deletions.

## Historical evidence and review boundaries

Reviewed the earlier enrollment account-switch browser test in Git history,
alongside the current test and marked-fixture cleanup.
The earlier test created:

- Two Clerk identities using `audit-fixture-dashboard-late-a-` and
  `audit-fixture-dashboard-late-b-` email prefixes, with the general
  `auditLiveFixture: radiant-audit-live-v1` private metadata.
- A tag from `randomUUID().slice(0, 12)` (including a hyphen), rather than the
  newer twelve-hex-character tag.
- A category named `Private learning <tag>` with slug `learning-<tag>`.
- A published Free course with the same title and description, instructor
  `Test learner`, and two published lessons.
- An enrollment for account A with one completed lesson, and a completion
  referencing that account and the first lesson.

These patterns are **review leads, not ownership proof**. General Audit
metadata cannot establish course-switch ownership. A missing Clerk identity
also cannot establish ownership of a surviving public course. No matcher was
broadened, and no records were relabeled to make them eligible for cleanup.

## Development inventory

The existing `requireAuditDevelopment` guard passed before Clerk inspection.
It checks development Clerk keys, the workspace preview, and that the database
URL matches the workspace development database without target-changing options.
Clerk management status was confirmed as managed.

Paginated the complete development Clerk user list in batches of 100:

| Inspection | Result |
| --- | ---: |
| Clerk accounts scanned | 12 |
| Accounts with either legacy dashboard-late email prefix | 0 |
| Accounts with a newer course-switch A/B email prefix | 0 |

Independently inspected the development database in a read-only transaction,
including potential orphaned content even if its Clerk account was already gone:

| Inspection | Result |
| --- | ---: |
| Categories with `learning-` or `course-switch-` slugs, or Private learning / Course-switch names | 0 |
| Courses with Private learning / Course-switch titles or descriptions | 0 |
| Lessons with Private learning / Course-switch titles | 0 |
| Local users with legacy dashboard-late or course-switch email prefixes | 0 |
| Activity with Private learning / Course-switch entity titles | 0 |

Name/title searches were case-insensitive and used substring matching to include
renamed titles that still retained the original phrase. No member answers,
account identifiers, addresses, or private metadata are stored in this report.

## Ownership and linked-row disposition

There were no candidate identities, local member rows, categories, courses,
lessons, or activity rows to attribute or remove. Consequently there were no
candidate IDs for a linked-row ownership review or manual deletion.

This is a point-in-time, pattern-based inventory, not proof that arbitrarily
renamed or reidentified records could never exist. Anything with uncertain
ownership must remain untouched.

For any future candidate, establish independent ownership for each exact
identity and course, then inventory every linked row before considering removal:
category courses, course lessons/enrollments, lesson completions, each identity's
other enrollments/completions, local member records, all Audit records,
announcements and activity/review corrections, story subject/permission/
withdrawal/removal/review references and corrections, and membership checkouts.
Inspect actual database foreign keys and non-FK identity references as well.
Recheck ownership and relationships immediately before any explicitly scoped
manual deletion; this report supplies no deletion authorization.

## Outcome

No leftovers found within the historical patterns reviewed. No database rows
or Clerk accounts were changed. The existing automatic cleanup and browser
fixture definitions remain unchanged.