---
name: Development DB URL guard
description: Why integration-test database guards must permit connection options while checking the development target.
---

Workspace development DATABASE_URL can contain connection options such as SSL mode. A guard that rejects every query string blocks legitimate integration checks even when the host, port, database, and user match the workspace PG target.

**Why:** Connection settings and connection targets are different concerns; rejecting all URL options can block a legitimate development database while target-changing options remain unsafe.

**How to apply:** Compare connection identity against the workspace PG target, reject URL options that can redirect the connection, and allow options that do not change the database target.

Database safety boundaries must validate the actual process environment that initializes the database client, even when outer orchestration accepts an injected environment for tests.

**Why:** A safe injected environment does not prove that the shared database client points at that target; a direct exported helper can also bypass an entrypoint-only guard.

**How to apply:** Validate the actual database environment before dynamic imports or database work at every externally callable maintenance boundary. Keep database-only checks independent of optional browser or identity-provider prerequisites.