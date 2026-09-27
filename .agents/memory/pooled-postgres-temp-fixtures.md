---
name: Pooled PostgreSQL temp fixtures
description: Session-local database fixtures persist across tests when a connection is returned to a pool.
---

Temporary PostgreSQL functions and tables belong to the connection session, not the individual test. Releasing a client to a pool does not drop them.

**Why:** A later integration case reused the same connection and failed while creating an already-existing temporary trigger function, before reaching the behavior under test. Drizzle also wraps the underlying PostgreSQL error in a `cause`, unlike direct `pg` queries.

**How to apply:** Tear down all temporary functions, triggers, and tables before releasing pooled clients; for database error assertions, inspect the driver error directly or the ORM wrapper's cause according to the repair path.