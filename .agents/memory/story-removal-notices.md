---
name: Story removal notice semantics
description: Why owner story-removal indicators show historical requests rather than pending cases
---

The owner indicator reports removal requests received, including requests the owner may have already read. It does not claim they are unresolved or unread.

**Why:** A removal claim immediately hides the story, but the system has no durable review or acknowledgement state. Treating every claim as "pending review" in an alert would imply knowledge the system does not have.

**How to apply:** Keep indicator language factual until a separate owner review workflow records a durable resolution; then distinguish outstanding and historical requests explicitly.