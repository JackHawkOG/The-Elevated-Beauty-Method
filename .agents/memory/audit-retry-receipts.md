---
name: Audit retry receipts and privacy
description: Privacy constraint for idempotent Audit submissions and explicit deletions
---

Audit save retries use durable receipts that include answer snapshots, not just opaque identifiers. Explicit deletion of a current or historical Audit must also erase these receipts for that member.

**Why:** Otherwise a UI promise of permanent deletion would be false even though the visible Audit rows are gone. Clearing receipts on deletion may end replay protection for older submission IDs; that is preferable to retaining deleted personal reflections.

**How to apply:** When changing Audit deletion or retry storage, verify that no hidden answer copies survive a successful deletion. Do not add long-lived response caching without a deletion path.

Retry receipts are deliberately temporary, so replay protection has a time limit. After a receipt is purged, the same submission ID is indistinguishable from a new save and may create another retake.

**Why:** Keeping answer snapshots indefinitely to recognize old IDs would undermine privacy; storing permanent tombstones is a separate tradeoff, not part of receipt retention.

**How to apply:** When changing automatic retries or client-side pending saves, check how long the client may retain an unconfirmed attempt. Do not assume idempotency survives receipt expiry.