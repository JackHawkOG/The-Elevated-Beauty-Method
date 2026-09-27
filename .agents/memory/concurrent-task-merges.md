---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check contradicts an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change code or add tests between checks.

**Why:** Completion validation can run against a newer worktree than the one used for a focused check, particularly while independent changes are merging; a failure may come from a newly merged change.

**How to apply:** Re-read the affected files, repair the current state, and run the configured check again. Include test fixtures and mocked dependencies in that inspection: newly added production hooks can make previously valid isolated component tests fail without a product regression. Also inspect recently merged test bodies for lost assertions or duplicate setup, even when the changed feature is unrelated; syntax checks alone will not catch missing coverage. A later merge can alter the same test between a passing configured check and task completion, so treat completion feedback as a snapshot of the latest worktree rather than proof that the earlier check was unsound. Do not infer current code from an earlier diff.

When concurrent changes touch the same test file, verify the entire suite after the merge, not just the conflict region or your new cases.

**Why:** A merge can preserve both sides' text while displacing statements, duplicating tests, or dropping setup and assertions; a previously passing focused run no longer describes the merged file.

**How to apply:** Reconcile each test's intended behavior and run the full affected suite on the merged worktree.
