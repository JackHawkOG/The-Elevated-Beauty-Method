---
name: Headless focus events
description: How to verify return-focus refreshes reliably in the Audit browser harness
---

In the headless Chromium browser harness, switching tabs and bringing the original tab forward did not reliably emit a window focus event. Explicitly dispatch a focus event in a focused test of the handler; do not interpret a failed tab-switch test alone as proof the handler is broken.

**Why:** A browser check waited for a history refetch after bringing a tab to front, but no focus event arrived even after the handler was installed. Dispatching the event verified the refetch and stale-selection behavior.

**How to apply:** For focus-triggered browser tests, explicitly fire the browser event or instrument it before depending on headless tab activation. Keep separate coverage for visibilitychange when that distinct path matters.