---
name: OpenAPI integer codegen compatibility
description: Compatibility of generated integer schemas with the installed Zod runtime
---

The current OpenAPI generator can emit `z.int()` for `type: integer` even though the generated package resolves Zod v3, where that method does not exist.

OpenAPI `format: uuid` has the same compatibility issue: it emits `z.uuid()`. A UUID regex pattern preserves validation without relying on that unavailable top-level method.

**Why:** Integer and UUID profile-version fields exposed generator defaults targeting a newer Zod API than the installed runtime.

**How to apply:** When adding integer fields to the API contract, check generated Zod output and runtime compatibility before relying on the new schema. Prefer fixing generator compatibility over weakening a contract when practical.