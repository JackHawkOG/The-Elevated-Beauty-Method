---
name: Clerk signup identity timing
description: How development Clerk signup exposes an identity around email-code verification
---

A newly started Clerk signup can show the email verification screen before the backend users list contains the new user. Do not assume an unverified user ID exists at this point.

**Why:** A real signup browser check found no user in the Clerk users list before entering the email code, even though verification had been prepared successfully.

**How to apply:** Assert no Audit write and no matching development app user before verification; resolve the new Clerk ID after verification to check ownership. Cleanup should look up the unique disposable email because an interrupted signup may create the ID at a different point.