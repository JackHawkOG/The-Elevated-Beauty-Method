---
name: Audit live refresh checks
description: Reliable refresh and selection assertions in signed-in Audit browser checks
---

In a signed-in browser test with an open confirmation, synthetic focus and visibility events may not trigger a React Query history refetch. A real browser offline-to-online transition does trigger the reconnect refresh without mocking the server.

**Why:** A synthetic focus event left the first session's old history in place even after the second session had deleted the selected item. The reconnect path produced a real authenticated GET and let the test observe the updated selection.

**How to apply:** When testing refreshed data with the confirmation still open, wait for the authenticated history response after bringing the page online. Radix hides the background page from accessibility queries while its modal is open; use a stable DOM locator to inspect the underlying select, then use accessible locators for the dialog itself.