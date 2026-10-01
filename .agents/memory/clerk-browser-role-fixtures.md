---
name: Clerk browser role fixtures
description: The programmatic browser sign-in helper does not apply arbitrary role metadata
---

Do not assume passing `publicMetadata` to the browser testing helper's Clerk sign-in options grants a role. Extra metadata options were ignored, leaving the disposable user's public metadata empty.

**Why:** The helper successfully signed in the test user, but the app correctly treated that identity as a member. An absent owner banner in that state is not evidence about owner behavior.

**How to apply:** Establish and verify role metadata through a supported disposable fixture before owner-only browser assertions. Keep component response fixtures and server authorization tests explicit about which boundary they cover. If a role cannot be established, report the browser check as blocked, not as a passing owner test.