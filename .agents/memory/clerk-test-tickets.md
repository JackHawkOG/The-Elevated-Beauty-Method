---
name: Clerk test tickets
description: The lifecycle of short-lived development Clerk sign-in tickets in browser checks.
---

Successful ticket-based sign-in consumes the ticket. Calling the revoke endpoint afterward can return a Bad Request, hiding the actual browser-test result.

**Why:** A browser check failed during cleanup even though sign-in succeeded; removing the post-sign-in revocation exposed the real assertion result.

**How to apply:** In development-only browser checks, give tickets a short expiry, delete the disposable Clerk identity during cleanup, and don't revoke a ticket after it was consumed.