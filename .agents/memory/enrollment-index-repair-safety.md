---
name: Enrollment index repair safety
description: Why enrollment startup repair rejects misleading named indexes instead of replacing them automatically
---

When a legacy enrollment index has the expected name but does not enforce uniqueness for user/course pairs, fail the transactional repair rather than automatically dropping and recreating the index.

**Why:** An existing index may be owned by a constraint or have other dependencies; silently replacing it can break unrelated schema assumptions. A failed transaction leaves both the legacy data and index available for deliberate inspection and correction, and prevents the app from treating enrollment repair as successful.

**How to apply:** Keep the SQL migration and startup repair aligned. Validate the actual index properties after attempting idempotent creation, and keep legacy regression checks in isolated tables rather than modifying public enrollment data.