---
name: Delayed Clerk response tests
description: Testing late authenticated responses across same-tab account switches
---

For same-tab account-switch race checks, capture a real authenticated API response using a browser-side fetch while the first development test user is signed in, then hold and fulfill a matching browser route with that response after switching users.

**Why:** Re-fetching an intercepted Clerk-session request through Playwright's route.fetch returned 401 despite the app's browser request working. Capturing in the signed-in browser keeps the fixture tied to the actual member and avoids relying on a separate request context's cookie behavior.

**How to apply:** Guard tests to development keys and database, confirm the captured response belongs to the first disposable identity, and release the held route after the second identity becomes active. A canceled former request is also safe; check both transient UI and the second member's completed view.