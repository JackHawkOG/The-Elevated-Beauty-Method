---
name: Delayed Clerk response tests
description: Testing late authenticated responses across same-tab account switches
---

For account-switch race checks, use a response captured from the signed-in browser rather than a separate request context.

**Why:** A separate Playwright request context can receive a 401 for a Clerk-session request even when that request succeeds in the signed-in browser.

**How to apply:** When simulating late authenticated responses, capture the first account's response in its own browser session; verify no first-account answers appear after switching identities.