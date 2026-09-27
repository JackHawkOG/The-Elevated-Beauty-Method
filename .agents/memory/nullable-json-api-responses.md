---
name: Nullable JSON API responses
description: How nullable API responses behave with the shared fetch client's automatic response parser.
---

For direct generated client calls to endpoints that can return a JSON `null`, request `responseType: "json"` explicitly rather than relying on automatic response inference.

**Why:** The shared fetch client selects JSON using the response content type. If a mocked endpoint serves a literal `null` without a JSON content type, automatic mode treats it as text, yielding the truthy string `"null"` and silently breaking empty-state and draft recovery decisions. This was found after several browser checks of a cross-device draft flow.

**How to apply:** On direct generated client calls whose contract includes null, pass the JSON response mode. For generated hooks, check whether their transport supports that request option when empty responses drive a decision.