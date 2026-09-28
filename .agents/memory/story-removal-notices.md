---
name: Story removal notice semantics
description: Why owner story-removal indicators show only outstanding requests
---

The owner indicator reports only outstanding removal requests; reviewed requests remain in the private story history instead of the alert.

**Why:** A removal claim immediately hides the story. Once the owner records a private review, it is no longer outstanding, but the story remains hidden regardless of outcome.

**How to apply:** Filter the alert by persisted review state; do not infer review from the story's withdrawn status, and keep reviewed cases accessible in private history.