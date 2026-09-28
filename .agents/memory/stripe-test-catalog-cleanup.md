---
name: Stripe test catalog cleanup
description: Limits on deleting products used by disposable Stripe subscriptions.
---

Stripe does not delete a product once it has a user-created recurring price, even after its subscriptions are canceled. Repeated live checks should reuse an explicitly marked, free, test-mode catalog rather than archiving a new product and price every time. Archive only older per-run catalog records, not the shared fixture.

**Why:** A live membership privacy check passed but its cleanup failed when it attempted to delete the product after archiving the price.

**How to apply:** Guard the Stripe client against live keys before any fixture lookup or mutation. Verify the ownership marker and zero-cost price before reuse; cancel per-run subscriptions and remove customers, but preserve shared catalog entries for later runs. Cleanup of interrupted older fixtures may still archive their separately owned catalog.