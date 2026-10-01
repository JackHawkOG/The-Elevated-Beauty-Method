---
name: Stripe portal fixture safety
description: Avoid changing account-wide defaults in real Stripe portal integration checks.
---

Real portal URL checks should reuse an existing compatible test-mode portal configuration without changing it, and create only a disposable customer.

**Why:** Stripe makes the first portal configuration the account default and rejects deactivating it. A supposedly disposable configuration can therefore leave persistent account-wide settings. A test-only default configuration remains from discovering this behavior; it cannot be deactivated while it is the default.

**How to apply:** Fail explicitly when the required test configuration is absent rather than silently creating or modifying shared settings. Never open, persist, or print portal session URLs; they grant access. Preserve the frontend's destination rules when a real response fails them.