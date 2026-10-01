---
name: Enrollment index repair safety
description: Why enrollment startup repair rejects misleading named indexes instead of replacing them automatically
---

When a legacy enrollment index has the expected name but does not enforce uniqueness for user/course pairs, fail the transactional repair rather than automatically dropping and recreating the index.

**Why:** An existing index may be owned by a constraint or have other dependencies; silently replacing it can break unrelated schema assumptions. A failed transaction leaves both the legacy data and index available for deliberate inspection and correction, and prevents the app from treating enrollment repair as successful.

**How to apply:** Keep the SQL migration and startup repair aligned. Validate the actual index properties after attempting idempotent creation, and keep legacy regression checks in isolated tables rather than modifying public enrollment data.

For deliberate operator recovery, preserve the incompatible index by renaming it rather than dropping it or its owning constraint. Keep all writers offline across the rename, merge and duplicate-insert verification.

**Why:** Renaming retains dependency OIDs and foreign keys, while dropping an index or constraint can destroy unrelated schema guarantees. Separate transaction locks do not protect the intervals between recovery steps.

**How to apply:** Inspect dependencies in both directions and review references to duplicate identities before approving recovery. Treat a verification failure as an offline state, even when the merge has already committed.