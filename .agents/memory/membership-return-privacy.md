---
name: Membership return privacy
description: Why paid-return attribution must use checkout-specific confirmation rather than tab storage
---

Do not restore the account-and-kind tab marker as proof of a paid checkout return. Match the return to the authenticated server-confirmed checkout and remove the private correlation before firing the fixed-kind analytics event.

**Why:** Session storage can be blocked, and an abandoned marker can match an unrelated later purchase of the same plan. Account and plan equality do not prove checkout identity.

**How to apply:** Keep correlation private to the return flow and authenticated membership response. Analytics properties must contain only the fixed membership kind. Legacy links without correlation must not count.