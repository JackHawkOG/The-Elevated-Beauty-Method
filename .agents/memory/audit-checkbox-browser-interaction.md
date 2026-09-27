---
name: Audit checkbox browser interaction
description: A live-browser interaction detail for the Audit form's visually hidden checkbox controls
---

For end-to-end browser checks, click the visible label of an Audit check option rather than using Playwright's checkbox `check()` on its visually hidden input.

**Why:** The label intercepts pointer events over the screen-reader-only input, and the development banner can also intercept retry clicks. Waiting longer does not solve this.

**How to apply:** Use an accessible label click or a label selector when testing a real browser with the development preview; keep assertions on the resulting state. This is not a reason to force-click the hidden input.