---
name: Audit draft revisions
description: Why draft deletion markers and monotonic timestamps matter for cross-device conflict checks
---

For conditional Audit draft writes, the deletion marker must count as a version, not as an empty draft. A client with an older version must not recreate answers after another device explicitly discarded them without choosing to do so.

**Why:** A timestamp can otherwise collide when two writes happen within one millisecond, and a marker that is treated as absence lets delayed writes resurrect discarded answers.

**How to apply:** Serialize writes and discards for one account, advance the version strictly beyond the previous timestamp, and return a conflict for stale versions. When a conflict involves a deletion marker, let the member explicitly choose to restore local answers or keep the deletion.