---
name: Paid founding recovery
description: Capacity tradeoff when restoring a paid checkout whose local reservation was lost
---

Restore a verified paid founding checkout even if newer pending reservations have filled the nominal limit. Count the restored row toward capacity, and never expire or cancel an already-paid session to preserve the limit.

**Why:** A payment may complete on a Stripe link after the local transaction rolled back. Later reservations can consume the freed place before the paid session is discovered; refusing restoration would leave a paying member without access.

**How to apply:** Serialize restoration with new reservations, verify Stripe ownership and payment before restoring, and treat a temporary overage from already-paid sessions as preferable to denying paid access.