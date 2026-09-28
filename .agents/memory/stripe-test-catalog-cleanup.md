---
name: Stripe test catalog cleanup
description: Limits on deleting products used by disposable Stripe subscriptions.
---

Stripe does not delete a product once it has a user-created recurring price, even after its subscriptions are canceled. Archive the price and product instead; the historical test-mode catalog records remain.

**Why:** A live membership privacy check passed but its cleanup failed when it attempted to delete the product after archiving the price.

**How to apply:** When designing future Stripe test fixtures, avoid creating a fresh product/price on every run if a reusable, explicitly test-owned zero-cost catalog entry will do. Cancel test subscriptions and remove customers before archiving or reusing catalog entries.