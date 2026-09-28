---
name: pnpm audit workspace rewrites
description: Preserve workspace configuration intent when using pnpm audit --fix in this monorepo.
---

Treat `pnpm audit --fix` output as a proposed workspace-wide override change, not a finished dependency update. Review the resulting shared configuration before installing and verify the lockfile separately.

**Why:** The command rewrote the workspace configuration and dropped an explanatory security comment, while suggesting overlapping version-range overrides that still required lockfile regeneration. Repeated invocations from nested workspace package directories made the same shared change rather than producing independent package-specific fixes.

**How to apply:** After audit --fix, retain the project's supply-chain policy and intentional overrides, simplify overlapping fixes without crossing unaffected major versions, then install and audit the regenerated lockfile.