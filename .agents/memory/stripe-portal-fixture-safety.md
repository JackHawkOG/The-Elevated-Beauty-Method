---
name: Stripe portal fixture safety
description: Avoid changing account-wide defaults in real Stripe portal integration checks.
---

Real portal URL checks should reuse an existing compatible test-mode portal configuration without changing it, and create only a disposable customer.

**Why:** Stripe makes the first portal configuration the account default and rejects deactivating it. A supposedly disposable configuration can therefore leave persistent account-wide settings. A test-only default configuration remains from discovering this behavior; it cannot be deactivated while it is the default.

**How to apply:** Fail explicitly when the required test configuration is absent rather than silently creating or modifying shared settings. Never open, persist, or print portal session URLs; they grant access. Preserve the frontend's destination rules when a real response fails them.

Before declaring a portal response incomplete, compare the entire URL structure with current Stripe documentation, without logging bearer values. A missing path token does not imply a missing session identifier.

**Why:** A test response using Stripe's documented query-secret format was repeatedly misdiagnosed as an integration outage because only the pathname was inspected. Agreement across request paths confirmed reproducibility, not invalidity. This unnecessarily sent the user to support and prompted dashboard changes that could not fix the validator.

**How to apply:** Inspect token presence and uniqueness as booleans, consult https://docs.stripe.com/api/customer_portal/sessions/create, and distinguish session links from reusable portal login links. Keep HTTPS, exact-host, and exact session-path restrictions. Never fabricate a URL token from the session object's ID or infer production behavior from test-mode observations.