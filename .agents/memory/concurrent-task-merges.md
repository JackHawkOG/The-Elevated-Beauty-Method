---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check reports errors that contradict an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change files or add related tests during a task.

**Why:** A progress test passed locally, but its setup was incomplete in the later completion check, which also encountered a newly merged browser progress test and its missing import.

**How to apply:** Re-read the affected files after a completion failure, repair the current state, and run the configured check again. Do not infer the current code from an earlier diff.