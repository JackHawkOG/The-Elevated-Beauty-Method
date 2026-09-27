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
draft. In `finally`, it deletes the accounts and only their associated
database rows and temporary curriculum, even when an assertion fails.

Routine `pnpm run check` and the fast `pnpm run test:progress` suite remain
browser/Clerk-independent. Run the pre-release gate only where all prerequisites
are available; do not add it to the routine unit-check workflow.