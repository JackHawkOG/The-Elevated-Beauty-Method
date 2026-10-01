---
name: Concurrent task merges
description: How to respond when task completion checks encounter newly merged changes.
---

When a completion check contradicts an earlier successful focused run, inspect the current worktree and validation output before assuming the earlier result was wrong. Concurrent task merges can change code or add tests between checks.

**Why:** Completion validation can run against a newer worktree than the one used for a focused check, particularly while independent changes are merging; a failure may come from a newly merged change.

**How to apply:** Re-read the affected files, repair the current state, and run the configured check again. Include test fixtures and mocked dependencies in that inspection: newly added production hooks can make previously valid isolated component tests fail without a product regression. Also inspect recently merged test bodies for lost assertions or duplicate setup, even when the changed feature is unrelated; syntax checks alone will not catch missing coverage. A later merge can alter the same test between a passing configured check and task completion, so treat completion feedback as a snapshot of the latest worktree rather than proof that the earlier check was unsound. Even a clean git status can hide a just-committed malformed merge; check the actual file boundaries and test count rather than relying on the diff. Do not infer current code from an earlier diff.

Generated files are especially prone to valid-but-duplicated merge output when independent tasks regenerate them. If a clean worktree fails typechecking with duplicate generated declarations after a merge, regenerate from the current source contract before changing the contract or patching generated declarations by hand. **Why:** Each task's generated output can pass alone, but a merge can combine declarations from different generated revisions. **How to apply:** Regenerate, verify the duplicates disappear, then run the configured check against that refreshed worktree.

If regeneration instead exposes a generated forward reference and the same merge also breaks unrelated route boundaries or tests, don't assume regeneration repaired the merged feature. **Why:** A focused feature test can pass while a newly merged, unrelated feature remains malformed in the shared worktree. **How to apply:** Attribute each full-check failure to its current source, fix the assigned feature's own findings, and treat broad repairs to unrelated merged functionality as a separate risk rather than silently folding them into a narrow task.

After resolving a generated-file conflict, inspect source files from both tasks even if they were not flagged as conflicts. **Why:** Semantic reconciliation can interleave repeated route blocks and leave source syntax or behavior broken without reporting that file as conflicted. **How to apply:** Typecheck and rerun the affected route suite against the rebased worktree; reconstruct the affected route from the current main version plus the intended feature if blocks were displaced.

When concurrent changes touch the same test file, verify the entire suite after the merge, not just the conflict region or your new cases.

**Why:** A merge can preserve both sides' text while displacing statements, duplicating tests, or dropping setup and assertions; a previously passing focused run no longer describes the merged file.

**How to apply:** Reconcile each test's intended behavior against its pre-merge version and run the full affected suite on the merged worktree. If the configured validation excludes a repaired test file, run that suite explicitly too; typechecking alone will not catch lost assertions.

If an unrelated merged fixture has extensive structural corruption rather than a local conflict, do not treat its repair as a minor validation fix inside an otherwise isolated task.

**Why:** A malformed fixture may require reconstructing multiple tests and behaviors; a quick syntax patch can create a misleading green check without restoring intended coverage.

**How to apply:** Identify the introducing merge and report the blocking check and the needed reconciliation separately when restoring the fixture exceeds the assigned scope.

When a shared branch has repaired a fixture while an isolated task is still open, compare against that latest shared version before submitting a local repair. A repair copied from an older known-good revision can merge with the newer fixture and reintroduce broken test setup even if local checks passed.

**Why:** Completion merges may combine overlapping fixture edits; a passing local check describes the pre-merge tree, not necessarily the submitted tree.

**How to apply:** Compare the whole touched fixture against the current shared branch, preserve new tests and their setup, and validate the reconciled version before retrying completion.

When the user authorizes a broader repair of a malformed fixture, compare it with its last known-good revision before replacing scattered invalid values. **Why:** Type errors can be only the visible part of a merge that also changed valid-looking counters or test setup, leaving runtime assertions wrong after typecheck passes. **How to apply:** Restore the intended fixtures and run the affected test file before relying on the full workspace check.

After a rebase adds dependencies, refresh the installed workspace from the merged lockfile before interpreting missing-package test failures as source defects.

**Why:** The Git merge updates package manifests and the lockfile, but the isolated task's installed dependencies can still reflect its earlier checkout.

**How to apply:** If a newly merged test cannot load a package already declared in the merged manifests, restore dependencies with the frozen lockfile rather than adding another declaration or changing the test.
