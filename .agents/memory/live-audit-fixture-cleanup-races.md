---
name: Live Audit fixture cleanup races
description: Why live form tests should stop their browser page before deleting disposable database identities
---

When a live test ends on an editable Audit form, close its page before deleting fixture rows, including in the failure path.

**Why:** The mounted form can issue an asynchronous draft write after a fixture's draft was deleted. Deleting the user immediately afterward then fails on a newly created draft's foreign key, masking a successful assertion or the original failure.

**How to apply:** Stop the page's form effects and network activity first, then run development-guarded cleanup for only the identities the test created. Wait for intended UI mutations before checking their outcomes.