# Member progress browser check

Start the existing **EduPortal** and **API Server** development workflows, then run:

```bash
pnpm run test:progress:browser
```

This separate check needs the development database, a development Clerk instance
(`sk_test_` secret key), `REPLIT_DEV_DOMAIN`, and the Chromium executable at
`/repl/tools/bin/chromium` (override with `CHROMIUM_PATH` if needed). It refuses
production Clerk keys or `NODE_ENV=production`. Do not run it against a
production database.

The test creates two disposable **real Clerk accounts**. It provisions one as
Elevated in the development database and keeps the other Free. It signs both
into isolated browser contexts using short-lived Clerk sign-in tickets. It
enrolls and completes two lessons using the app's controls, checks dashboard
and lesson markers after a browser reload, and confirms Free lesson and progress
requests are rejected. If no published Accelerator exists, it creates a
temporary published course and four lessons rather than publishing an existing
draft. In `finally`, it deletes the accounts and only their associated
database rows and temporary curriculum, even when an assertion fails.

The fast route/component suite remains `pnpm run test:progress`; it does not
exercise browser sessions.