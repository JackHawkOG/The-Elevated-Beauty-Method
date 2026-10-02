---
name: OpenAPI Zod target compatibility
description: Generator auto-detection can disagree with the generated validators' Zod runtime
---

Do not assume the API generator's automatic Zod-version detection matches the package that will consume the generated validators.

**Why:** Generation has emitted Zod 4 integer, email, and UUID helpers while the generated validator package resolves Zod 3. Detection can fall back to a newer API when it does not resolve the consumer's dependency.

**How to apply:** Match the generator's explicit target to the consuming package and typecheck generated libraries. Check formatted strings as well as integer fields. Prefer correcting generation over weakening valid API constraints or hand-editing generated code.

Regenerate clients and validators from the combined contract after merging independently generated API changes, even when Git reports no conflicts in generated files.

**Why:** A conflict-free automatic merge retained duplicate maximum-bound exports from separate generation runs, preventing the API from building. A clean merge is not proof that generated output corresponds to the combined contract.

**How to apply:** Use the complete generation command, including its ordering postprocessor, before diagnosing generated declaration errors or changing valid API bounds.