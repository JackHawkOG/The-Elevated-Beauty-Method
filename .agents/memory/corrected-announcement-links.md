---
name: Corrected announcement links
description: Why historical announcement feed reconciliation must respect explicit corrections.
---

An owner's correction to a legacy announcement feed assignment is a review decision, not missing data to repair automatically. Treat previously corrected posts as requiring human review when their feed link is absent.

**Why:** If automatic reconciliation treats an intentionally unlinked post as an ordinary historical gap, a later server startup could recreate the disputed assignment or insert another feed entry based only on weak matching signals.

**How to apply:** When changing legacy announcement repair or adding other backfills, consult correction history before assigning or synthesizing feed entries. Preserve one-to-one assignment and require fresh evidence for any new manual link.