---
name: OpenAPI integer codegen compatibility
description: Compatibility of generated integer schemas with the installed Zod runtime
---

The current OpenAPI generator can emit `z.int()` for `type: integer` even though the generated package resolves Zod v3, where that method does not exist.

**Why:** A new integer response field caused the generated library typecheck to fail; using a numeric response field avoided the mismatch.

**How to apply:** When adding integer fields to the API contract, check generated Zod output and runtime compatibility before relying on the new schema. Prefer fixing generator compatibility over weakening a contract when practical.