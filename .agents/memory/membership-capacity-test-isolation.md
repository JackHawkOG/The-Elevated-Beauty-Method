---
name: Membership capacity test isolation
description: Prevent concurrent validations from corrupting last-place capacity fixtures
---

Tests that fill the real development database to the founding membership limit must coordinate for the entire fixture lifetime, including setup, HTTP requests, assertions, and cleanup. Locking only the reservation transaction is insufficient for test isolation.

**Why:** Separately triggered validations can run at the same time against one development database. Each may observe available places before the other's fixtures are inserted, then both fill the inventory and make the last-place assertions fail for reasons unrelated to application behavior.

**How to apply:** Have any future membership capacity integration suite use the shared test-only coordination lock around its fixtures and release it after cleanup; do not confuse it with the application's production reservation lock.

Test-only coordination also does not exclude the running API's background billing sweeps. A suite can own the capacity fixture lock while a live sweep owns a separate scanner lock, making a test-triggered recovery return without processing its mocked sessions.

**Why:** A full validation immediately after API startup reported multiple recovery failures with no mocked Stripe lookups; the same unchanged suite passed once the startup sweep had finished.

**How to apply:** When designing shared-database recovery checks, account for background workers as well as other test processes. Do not weaken recovery assertions or change billing behavior merely to accommodate transient scanner contention.