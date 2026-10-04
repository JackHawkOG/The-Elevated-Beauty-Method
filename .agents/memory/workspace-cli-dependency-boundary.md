---
name: Workspace CLI dependency boundary
description: Why standalone maintenance commands must respect pnpm workspace executable and import resolution.
---

Root package scripts in this workspace do not necessarily have access to executables installed only in a child package. A standalone TypeScript maintenance command also needs to live inside the package that owns its imports, or typechecking and module resolution can fail.

**Why:** A root-level invocation of a package-local TypeScript runner failed even though the runner was installed, and placing the command in a separate package caused TypeScript root-directory and missing-module errors.

**How to apply:** For future maintenance commands, run the executable through its owning workspace package and place the command where its runtime dependencies resolve, without adding redundant dependencies to unrelated packages.

Pass Playwright options directly to pnpm scripts, without an extra `--`.

**Why:** The extra separator reaches Playwright and stops option parsing; a requested grep can run the whole live suite instead, creating unnecessary external fixtures.

**How to apply:** Use `pnpm run test:audit-live --grep 'first-time real member'` for the focused real-Clerk check. Confirm the reported test count before interpreting results.