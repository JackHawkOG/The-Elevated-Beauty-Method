---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check contradicts an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change code or add tests between checks.

**Why:** Completion validation can run against a newer worktree than the one used for a focused check, particularly while independent changes are merging; a failure may come from a newly merged change.

**How to apply:** Re-read the affected files, repair the current state, and run the configured check again. Include test fixtures and mocked dependencies in that inspection: newly added production hooks can make previously valid isolated component tests fail without a product regression. Also inspect recently merged test bodies for lost assertions or duplicate setup, even when the changed feature is unrelated; syntax checks alone will not catch missing coverage. A later merge can alter the same test between a passing configured check and task completion, so treat completion feedback as a snapshot of the latest worktree rather than proof that the earlier check was unsound. Do not infer current code from an earlier diff.

When an automated rebase reports a structural conflict, check the entire conflicted file, not only the marked region. The merge driver can scatter unrelated statements from a function below the conflict markers; resolve using the intact staged versions as references and then run a parser or type check on the final file.

**Why:** A structurally conflicted test was rearranged beyond the conflict block, so removing markers alone would have left malformed code.

**How to apply:** Compare both staged file versions, preserve distinct behavior from each, and verify the whole resolved file before continuing the merge.
