---
name: Transaction test gates
description: Fail safely when deterministic concurrency tests wait for an intercepted request.
---

When pausing a real request transaction at a test gate, race the gate signal against early request completion and release all gates in `finally`.

**Why:** A request rejected before reaching the expected signal can otherwise hang until the test timeout, leaving transaction mocks active and disposable fixtures behind.

**How to apply:** Use an early-response failure alongside each awaited transaction-entry or commit-gate signal; settle pending requests before restoring mocks and deleting fixtures.