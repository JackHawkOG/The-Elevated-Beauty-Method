---
name: Vitest source-check callback shapes
description: A durable parsing caution when inspecting Vitest suites without executing them.
---

When locating a Vitest test body in source, do not assume its callback is the final call argument. A timeout may follow it, and parameterized tests use a curried `test.each(cases)(name, callback)` shape.

**Why:** A safety check initially missed guarded database tests because it read the optional timeout as the body and failed to identify the outer call of a parameterized test.

**How to apply:** Use the callback's defined argument position and account for both ordinary and curried registration forms when building future static checks.