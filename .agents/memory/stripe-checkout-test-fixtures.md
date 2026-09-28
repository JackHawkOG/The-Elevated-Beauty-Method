---
name: Stripe checkout test fixtures
description: Why expiration tests must retain the identity of retrieved checkout sessions
---

When simulating a Stripe checkout session changing from open to expired, preserve its original `id` in the returned session object. Prefer a typed fixture that reflects Stripe's session shape rather than a loose status-only mock.

**Why:** Replacing a mocked session with a status-only object can make a working release path look broken: the handler must match the retrieved session's identity to its saved reservation.

**How to apply:** In membership checkout and reconciliation tests, model state changes on one stable Stripe session rather than replacing the session with a partial object.

For a simulated lost Stripe response, the created session exists even though the mocked call rejects. Capture that session inside the mock before throwing; awaiting the mock's result will reject, and using a global count of remaining sessions can select an unrelated checkout after previous tests remove entries.

**Why:** A rejected response is not a missing Stripe session. Tests need the precise newly created session to distinguish recovery from unrelated cleanup.

**How to apply:** In lost-response tests, keep a per-test collection of sessions created before the simulated network error and assert against those objects.