---
name: Development DB URL guard
description: Why integration-test database guards must permit connection options while checking the development target.
---

Workspace development DATABASE_URL can contain connection options such as SSL mode. A guard that rejects every query string blocks legitimate integration checks even when the host, port, database, and user match the workspace PG target.

**Why:** A strict no-query guard rejected the actual development connection URL during the Audit integration run.

**How to apply:** Compare connection identity against the workspace PG target, reject URL options that can redirect the connection, and allow options that do not change the database target.