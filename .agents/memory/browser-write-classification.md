---
name: Browser write classification
description: Conservative safety policy for source-only checks of live browser specs.
---

Treat UI interactions as potential application writes rather than trying to infer safety from button labels or page names. Do not exempt a browser spec merely because it contains a route mock.

**Why:** A source-only check cannot determine which UI actions trigger persistence. Partial interception and forwarding mocks can still reach the real application, while Playwright API request contexts bypass browser route interception entirely.

**How to apply:** Prefer a development-target guard when isolation is uncertain. A mock exemption needs early, complete, non-forwarding API interception scoped to the writing test and its actual page; direct HTTP mutations still require a guard. Do not preserve isolation across helper calls unless their routing effects are proven, and treat unresolved request methods as potentially mutating.

Read live browser configuration selections statically; never execute configurations or load test suites just to discover safety-check inputs. Unresolved selections should stop the safety check rather than silently skip files.

**Why:** Configuration and test loading can itself perform fixture writes before the safety check has validated the target. Selection from live configurations avoids unnecessarily treating isolated mock-server suites as live.

**How to apply:** Keep discovery free of application code execution when extending supported Playwright configuration forms.

Mirror Playwright's file selection semantics, not generic platform glob defaults: its string patterns include hidden directories and ignore case, and relative inherited test directories use the entry configuration's directory.

**Why:** A narrower matcher or a different inherited-path base can silently omit tests that Playwright runs, defeating the safety check despite correct write classification.

**How to apply:** Cover selection edge cases with command-level fixtures when changing discovery or upgrading the matcher.