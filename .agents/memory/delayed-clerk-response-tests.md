---
name: Delayed Clerk response tests
description: Testing late authenticated responses across same-tab account switches
---

For account-switch race checks, use a response captured from the signed-in browser rather than a separate request context. Hold and fulfill the matching route with that captured response after switching users.

**Why:** A separate Playwright request context or `route.fetch()` can receive a 401 for a Clerk-session request even when that request succeeds in the signed-in browser.

**How to apply:** Guard tests to development keys and database, capture the first account's response in its browser session, then release the held route after the second identity becomes active. A canceled former request is also safe; verify no first-account answers appear after switching identities.

For lost-response POST checks, prefer wrapping the signed-in page's existing fetch: await the original successful response, consume a clone, then reject only that matching response. This tests a single real committed write without replaying it. An intercepted form request can also be mirrored from the signed-in page using its captured payload, authorization header, and idempotency key. Let that browser-originated request commit, then abort the intercepted form request so the UI sees a network failure.

**Why:** Playwright's `route.fetch()` replay of a Clerk-authenticated form request returned 401, while a signed-in browser fetch with the captured request data reached the real server.

**How to apply:** Match the exact method, path, and fixture payload; discard only the first successful response. Keep recovery reads untouched, verify committed rows, and count outgoing mutations. If using a mirrored request, mark it so the route handler lets it pass; intercept only the intended first attempt, not the subsequent form retry. Assert the server committed before aborting, then check that the retry reused the key.

For a late profile mutation, hold the return of the page's own `fetch` after the original response resolves. This allows the server to commit while the UI still awaits the response, without replaying a Clerk-authenticated request through Playwright's route fetch.

**Why:** Replaying an authenticated write through `route.fetch()` can lose its Clerk session; delaying the request itself can also prevent the server-side save being tested.

**How to apply:** Verify the server committed before switching identities in the same tab; release the held browser response only after the new member is active. Clerk's test sign-in may land on the dashboard, so reach the profile by an in-app link rather than reloading the document while the response is held.

Keep post-switch navigation in the same document when testing a delayed response
against the new account's query cache.

**Why:** A full browser navigation discards the query client and can make the
privacy assertion pass without exercising the cache boundary.

**How to apply:** Use actual in-app links where available. For direct lesson
routes, Wouter observes `history.pushState`; use that rather than `page.goto`
while the response is held, then exercise the visible navigation controls.

For held-write account-switch checks, keep a random document marker in memory
and assert it survives the entire sign-out/sign-in and in-app navigation.

**Why:** A reload can make a stale-callback test pass by discarding the pending
JavaScript rather than exercising the protection. An unchanged URL alone does
not prove the document survived.

**How to apply:** Set the marker before holding the browser fetch return and
compare it after the new member's protected page is ready, before releasing
the committed response.
