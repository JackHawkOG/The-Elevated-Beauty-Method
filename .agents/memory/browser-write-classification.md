---
name: Browser write classification
description: Conservative safety policy for source-only checks of live browser specs.
---

Treat UI interactions as potential application writes rather than trying to infer safety from button labels or page names. Do not exempt a browser spec merely because it contains a route mock.

**Why:** A source-only check cannot determine which UI actions trigger persistence. Partial interception and forwarding mocks can still reach the real application, while Playwright API request contexts bypass browser route interception entirely.

**How to apply:** Prefer a development-target guard when isolation is uncertain. A mock exemption needs early, complete, non-forwarding API interception scoped to the writing test and its actual page; direct HTTP mutations still require a guard. Do not preserve isolation across helper calls unless their routing effects are proven, and treat unresolved request methods as potentially mutating.