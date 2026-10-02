---
name: Audit browser test boundary
description: Why the Audit comparison browser regression uses controlled identity and responses
---

The repeatable Audit comparison browser regression deliberately uses controlled signed-in identity and account-scoped API responses, not live Clerk sessions or a development database.

**Why:** The existing server integration covers account isolation; isolating the browser test makes selection, reload, and analytics behavior deterministic without provisioning external test users. It does not prove the full Clerk-to-database path.

**How to apply:** Keep server ownership assertions independent of the UI regression. When changing auth/session wiring, add a separate real-session check instead of assuming the controlled browser test covers it.

Controlled browser checks must isolate downstream reads as well as writes, including reads that only become enabled after a successful save.

**Why:** An unmocked history read can reach a real server or receive the test server's HTML fallback; either breaks isolation and can make an otherwise successful flow fail while rendering.

**How to apply:** Cover every API request enabled by the destination page and keep the mock's saved state consistent across writes and subsequent reads.