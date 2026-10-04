---
name: Guide delivery test isolation
description: Why live guide-delivery checks need database namespace isolation rather than only unique addresses.
---

Run guide-delivery integration checks against a private migration-backed schema with no public search-path fallback, even when every request and address is explicitly owned by the test.

**Why:** Reserving a guide also deletes expired rate counters globally. Unique fixture IDs and scoped teardown alone would still allow that incidental cleanup to modify non-test records.

**How to apply:** Inject the real database-backed store using separate connections confined to the owned schema; inject a fake email sender. Drain requests before dropping the schema, reset session settings, and release every connection.