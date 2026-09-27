---
name: Audit draft privacy tradeoff
description: Why signed-in browser drafts are intentionally single-account and short-lived
---

Signed-in Audit recovery favors a single short-lived browser draft. Opening the form as another signed-in account discards the prior account's draft rather than preserving a separate draft for each account.

**Why:** Refresh and tab-close recovery require persistence beyond a mounted page, but keeping several members' sensitive written reflections on a shared browser increases exposure. The privacy choice is to give up recovery after an account switch.

**How to apply:** If changing draft storage or auth transitions, preserve account ownership checks and bounded retention; treat cross-account recovery as a separate, explicitly private server-side feature rather than expanding local browser retention.