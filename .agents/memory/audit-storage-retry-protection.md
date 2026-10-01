---
name: Audit retry protection without browser storage
description: Why memory-only Audit attempts require review before their first submission
---

If an Audit retry ID cannot be read back from browser storage, require a current-Audit review and explicit new-attempt confirmation before sending a fresh ID. Keep the sent ID and its original age in memory for unchanged in-page retries, even if storage recovers.

**Why:** After a reload, a storage-restricted browser cannot distinguish a new form from an earlier save whose confirmation was lost. A fresh ID can create a duplicate retake. Online answer drafts alone do not establish retry identity.

**How to apply:** Keep the reload-risk warning separate from ordinary draft warnings so autosave or editing cannot clear it. Changes to unconfirmed answers require review rather than silently generating a new ID. Treat silently ignored storage writes as failures too.