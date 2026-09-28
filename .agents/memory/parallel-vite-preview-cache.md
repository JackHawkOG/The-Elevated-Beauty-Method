---
name: Parallel Vite preview cache
description: Why the main web preview can become blank after running the Audit browser harness
---

When the standalone Audit Playwright harness starts its own Vite server alongside the managed web workflow, the managed preview can serve a stale optimized dependency chunk as a 504 and show a blank page even though the test harness passes.

**Why:** The servers share generated dependency state. In one run, the main route and API health check both returned 200, but the browser's dependency chunk request returned 504 until the managed web workflow restarted.

**How to apply:** If a preview goes blank immediately after running the standalone harness, identify the failed browser resource first; when it is a stale Vite dependency chunk, restart the existing managed web workflow rather than changing the app code or starting another server.