---
name: Membership return privacy
description: Why paid-return attribution must use checkout-specific confirmation rather than tab storage
---

Do not restore the account-and-kind tab marker as proof of a paid checkout return. Match the return to the authenticated server-confirmed checkout and remove the private correlation before firing the fixed-kind analytics event.

**Why:** Session storage can be blocked, and an abandoned marker can match an unrelated later purchase of the same plan. Account and plan equality do not prove checkout identity.

**How to apply:** Keep correlation private to the return flow and authenticated membership response. Analytics properties must contain only the fixed membership kind. Legacy links without correlation must not count.

Paid-return conversion counting uses an at-most-once server permission, not a guaranteed analytics delivery receipt. Do not restore client storage as the deduplication authority or retry tracking after an uncertain claim response.

**Why:** Manually reopening the original paid link can repeat a valid return across tabs and devices even after its first URL was consumed. A durable claim prevents duplicates without exposing checkout or account IDs to analytics. If analytics fails after claiming, the conversion can be undercounted; browser tracking and database commits cannot be made atomic.

**How to apply:** Only claim after exact authenticated checkout confirmation and URL sanitization, and when the tracker is available. Keep receipts with their checkout rather than retaining a separate identifying ledger after account cleanup.