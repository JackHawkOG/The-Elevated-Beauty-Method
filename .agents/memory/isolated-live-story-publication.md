---
name: Isolated live story publication
description: Privacy boundary for live owner-story browser fixtures
---

Live owner-story checks must publish a real record through the owner UI but keep it out of ordinary public and owner-management feeds. A per-run, unguessable visibility key makes it available only to the check's signed-out visitor; other owners do not see test records in their management view.

**Why:** Cleanup in a test `finally` block never runs after a killed process, leaving test quotes visible indefinitely. Hiding at query time is independent of cleanup, while a separate visitor still verifies actual publication and withdrawal.

**How to apply:** When extending story checks, preserve test-only visibility at insert time, include the matching key only on the designated test visitor's feed requests, and keep ordinary member stories unrestricted. Do not replace this boundary with a quote prefix filter or a shorter cleanup timeout.