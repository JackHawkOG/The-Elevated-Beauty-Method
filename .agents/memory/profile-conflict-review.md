---
name: Profile conflict review
description: Why profile edit baselines must not silently advance during refresh or retry
---

Do not automatically rebase an open profile form when another save or a refetch reports a new version. Keep the member's inputs and require an explicit review of the newer saved details before retrying against that version.

**Why:** A blind retry with a fresh version would pass the database concurrency check but still overwrite edits the member never saw. Refreshing a draft's baseline invisibly has the same problem.

**How to apply:** When adding cross-tab refresh or retry recovery, distinguish the latest displayed server profile from the version the open draft was based on. Only the member's conflict-resolution choice should authorize a new baseline for that draft.