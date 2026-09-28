---
name: OpenAPI Zod constant ordering
description: A generated Zod schema may reference its own bound constant before declaration after a contract change.
---

Generated Zod output can place a schema's maximum-bound constant (including numeric `maximum`, not only `maxLength`) after the schema that reads it. A fresh codegen run does not necessarily correct the order.

**Why:** A merged story-review contract produced a valid OpenAPI schema but a TypeScript forward-reference error in the generated Zod module, blocking the full workspace check. This is a generator ordering issue, not a database or endpoint type error.

**How to apply:** After codegen, run the library typecheck and inspect a forward-reference error before modifying the API contract. If the generated order remains wrong, keep the constant before its use; do not discard the bound or assume regeneration alone repaired it. Extend the generation-time ordering fix when a new bound triggers the issue.