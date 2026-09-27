---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check contradicts an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change code or add tests between checks.

**Why:** Completion validation can run against a newer worktree than the one used for a focused check, particularly while independent changes are merging; a failure may come from a newly merged change.

**How to apply:** Re-read the affected files, repair the current state, and run the configured check again. Include test fixtures and mocked dependencies in that inspection: newly added production hooks can make previously valid isolated component tests fail without a product regression. Do not infer current code from an earlier diff.
