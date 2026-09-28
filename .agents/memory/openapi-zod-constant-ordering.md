---
name: OpenAPI Zod constant ordering
description: A generated Zod schema may reference its own length constant before declaration after a merged contract change.
---

Generated Zod output can place a schema's `maxLength` constant after the schema that reads it. A fresh codegen run does not necessarily correct the order.

**Why:** A merged story-review contract produced a valid OpenAPI schema but a TypeScript forward-reference error in the generated Zod module, blocking the full workspace check. This is a generator ordering issue, not a database or endpoint type error.

**How to apply:** After codegen, run the library typecheck and inspect a forward-reference error before modifying the API contract. If the generated order remains wrong, keep the constant before its use; do not discard the length constraint or assume regeneration alone repaired it. Consider a durable generator workaround if the schema changes again.