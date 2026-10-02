---
name: Stripe sync in bundled server
description: Runtime packaging and connection-shape caveats for Stripe sync in this workspace
---

Keep the Stripe sync library external to the API server's bundled output when its migrations are needed.

**Why:** Its migration runner resolves SQL files relative to its installed package. Bundling its JavaScript alone makes migration startup appear successful while leaving the Stripe schema empty, then webhook setup fails.

**How to apply:** For future changes to Stripe startup or build packaging, check that migrations exist in the runtime package and verify the managed webhook can initialize after a clean database. Connector credential settings are integration-specific; do not assume the example field names are current, and never print secret values while checking their shape.

Do not bypass startup backfill when a cached customer no longer exists in
Stripe. Confirm the exact customer's deleted state with Stripe, persist the
confirmed deletion through the sync library, and retry the complete backfill.

**Why:** The sync library's payment-method sweep uses cached non-deleted
customers. A missed deletion webhook can make a deleted test customer stop
startup even though listing current Stripe customers succeeds. Merely catching
the error would leave later resource types unsynced.

**How to apply:** Repair only verified deleted customers, bound retries, and
keep authentication failures, retrieval outages, live customers, cache-write
failures and unrelated errors fatal. Use the library's account-scoped upsert,
not direct edits to its managed schema.