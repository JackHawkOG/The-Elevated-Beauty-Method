---
name: Parallel Vite preview cache
description: Why the main web preview can become blank after running the Audit browser harness
---

When two Vite servers share generated dependency state, one preview can serve a stale optimized dependency chunk as a 504 and show a blank page even though the app routes are healthy.

**Why:** A route and API health check can both pass while a browser dependency chunk fails because the other server changed the shared optimization cache.

**How to apply:** Diagnose the failed browser resource before changing app code; for a stale Vite dependency chunk, restart the existing managed workflow rather than starting another server.