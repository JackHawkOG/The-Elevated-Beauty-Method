# Member progress browser check

In a suitable **development validation workspace**, start the existing
**EduPortal** and **API Server** development workflows, then run the explicit
pre-release gate before publishing:

```bash
pnpm run check:pre-release
```

This runs the normal type and route/component checks, followed by the signed-in
browser check. A failed prerequisite or browser assertion fails the command; do
not publish until it passes. The browser check needs the workspace development
database (`DATABASE_URL` matching the development `PG*` target), development
Clerk keys (`sk_test_` and matching `pk_test_` server/web keys), a
`REPLIT_DEV_DOMAIN` preview, and an executable Chromium at
`/repl/tools/bin/chromium` (override with `CHROMIUM_PATH` if needed). It
refuses deployment/production environments and production keys, and checks both
development workflows before creating any test data. Never point the workflows
or database variables at production for this check. To run only the browser
check while debugging, use `pnpm run test:progress:browser`; it has the same
safety guards.

The test creates two disposable **real Clerk accounts**. It provisions one as
Elevated in the development database and keeps the other Free. It signs both
into isolated browser contexts using short-lived Clerk sign-in tickets. It
enrolls and completes two lessons using the app's controls, checks dashboard
and lesson markers after a browser reload, and confirms Free lesson and progress
requests are rejected. If no published Accelerator exists, it creates a
temporary published course and four lessons rather than publishing an existing
draft. After the check, it attempts to delete the accounts and only their
associated database rows and temporary curriculum, even when an assertion
fails. Every cleanup step is attempted even if another fails; the command
reports the original browser failure together with any named cleanup failures.
If cleanup fails, inspect and remove any remaining disposable development
records before rerunning the gate.

An interrupted process cannot perform cleanup. In the **development validation
workspace only**, run `pnpm run inspect:progress-leftovers` from the root. This
read-only dry run lists matching disposable Clerk identities, provisioned
members, fixture categories and enrollment activity older than one hour, with
their run UUIDs and the associated course and lesson IDs. Activity is reported
even when the accounts and curriculum were already removed, but only when its
actor name contains the exact run UUID and its type, description and course
title match the browser check's enrollment post.
It requires the same development database, test Clerk keys, preview and
Chromium safeguards as the browser check. No production keys or deployment
environment are permitted. It does not discover records whose original marker
names or emails were changed; review those manually.

Check the reported IDs against the interrupted run before deleting. To remove
one confirmed run, run
`pnpm run inspect:progress-leftovers --delete <run-uuid> <same-run-uuid>`.
The repeated UUID is an intentional confirmation, not a wildcard. Deletion
refuses records less than an hour old (including activity), mismatched markers, or curriculum
with non-fixture lessons or unrelated enrollments/completions. It removes only
the run's member progress, course/category (if present), matched activity rows
(including activity-only leftovers) and Clerk
users. If a database reference blocks deletion, it stops without cascading;
investigate before retrying. If Clerk deletion fails after database cleanup,
the dry run will still list the remaining Clerk identity for another attempt.
Do not run this command against production or edit its filters to broaden a
match.

Routine `pnpm run check` and the fast `pnpm run test:progress` suite remain
browser/Clerk-independent. Run the pre-release gate only where all prerequisites
are available; do not add it to the routine unit-check workflow.