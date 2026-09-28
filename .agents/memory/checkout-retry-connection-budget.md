---
name: Checkout retry connection budget
description: Why parallel Stripe recovery paths should reuse an already-held database connection.
---

Concurrent checkout retries can hold database advisory locks while they wait for Stripe. Do not acquire another pooled database connection from inside such a retry; use the lock-owning client for reconciliation and queue changes.

**Why:** Under enough simultaneous retries, every pooled connection can be held by a caller waiting for another connection, stalling cleanup and unrelated requests indefinitely. A review caught this even though ordinary serial tests passed.

**How to apply:** When adding new checkout recovery or staff-triggered retries, trace the whole call stack for nested pool acquisitions and exercise multiple retries paused at the external call before releasing them.