---
name: Wouter server rendering in tests
description: How to render linked Wouter components in Node-based component checks.
---

Use a static router hook that returns a pathname and no-op navigation when rendering Wouter-linked components to HTML in Node tests.

**Why:** The default browser location requires `location`, while Wouter's `memoryLocation` hook uses an external store without the server snapshot React requires for static rendering.

**How to apply:** Wrap the component in `Router` with a synchronous hook for server-rendered assertions. Use a browser-oriented test environment instead if navigation itself needs to be exercised.