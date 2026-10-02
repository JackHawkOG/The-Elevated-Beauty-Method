---
name: Shared membership decision snapshots
description: PostgreSQL snapshot boundaries when concurrent subscriptions determine one member's access.
---

Coordinate membership access decisions across subscriptions on the shared member, not only the individual checkout. Read the remaining confirmed subscriptions in a separate SQL statement after acquiring the member lock.

**Why:** Concurrent cancellations reproduced a committed state with both checkouts forfeited but the member still Elevated. Under PostgreSQL READ COMMITTED, waiting for a lock within a conditional UPDATE does not give its cross-row NOT EXISTS predicate a fresh statement snapshot. A separate locking statement followed by the decision lets the later transaction see the earlier cancellation's commit.

**How to apply:** Preserve checkout-before-member lock ordering when extending billing reconciliation or confirmation. Concurrent access tests should overlap real checkout writes before account-level decisions, retain the shared fixture-lifetime lock, and settle handlers before deleting their fixtures.