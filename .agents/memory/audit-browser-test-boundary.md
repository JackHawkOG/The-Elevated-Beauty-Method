---
name: Audit browser test boundary
description: Why the Audit comparison browser regression uses controlled identity and responses
---

The repeatable Audit comparison browser regression deliberately uses controlled signed-in identity and account-scoped API responses, not live Clerk sessions or a development database.

**Why:** The existing server integration covers account isolation; isolating the browser test makes selection, reload, and analytics behavior deterministic without provisioning external test users. It does not prove the full Clerk-to-database path.

**How to apply:** Keep server ownership assertions independent of the UI regression. When changing auth/session wiring, add a separate real-session check instead of assuming the controlled browser test covers it.