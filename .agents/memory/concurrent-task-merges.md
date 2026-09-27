---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check reports errors that contradict an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change files or add related tests during a task.

**Why:** Completion validation can run against a newer worktree than the one used for a focused check, particularly while independent changes are merging.

**How to apply:** Re-read the affected files after a completion failure, repair the current state, and run the configured check again. Do not infer the current code from an earlier diff.