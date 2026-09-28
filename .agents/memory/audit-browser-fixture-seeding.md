---
name: Audit browser fixture seeding
description: Avoid racing Audit form initialization when seeding browser-storage test fixtures.
---

Seed browser-storage Audit drafts while the browser is on a page without the Audit form, then navigate to the form.

**Why:** A mounted form may still run its initial empty-state draft effect after a test writes storage. That effect can erase the fixture before a reload, producing a misleading blank form instead of testing draft recovery.

**How to apply:** For browser tests that inject a saved Audit draft, move to a non-form route first, seed the record, then navigate to the form and assert it was restored.