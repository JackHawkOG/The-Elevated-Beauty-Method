---
name: Stripe sync in bundled server
description: Runtime packaging and connection-shape caveats for Stripe sync in this workspace
---

Keep the Stripe sync library external to the API server's bundled output when its migrations are needed.

**Why:** Its migration runner resolves SQL files relative to its installed package. Bundling its JavaScript alone makes migration startup appear successful while leaving the Stripe schema empty, then webhook setup fails.

**How to apply:** For future changes to Stripe startup or build packaging, check that migrations exist in the runtime package and verify the managed webhook can initialize after a clean database. Connector credential settings are integration-specific; do not assume the example field names are current, and never print secret values while checking their shape.