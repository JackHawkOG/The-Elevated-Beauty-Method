---
name: psql batch environment
description: libpq environment and noninteractive fail-stop behavior for isolated operator-command tests
---

When clearing inherited libpq service configuration for a test, remove `PGSERVICE` and `PGSERVICEFILE` rather than setting them to empty strings.

**Why:** libpq treats an empty service-file variable as a file to open and fails before executing any SQL. This can look like a recovery failure even though the recovery commands were never reached.

**How to apply:** Validate the development target before launching psql, retain its verified PG* connection settings, and remove optional service overrides from the child environment. Use `-X -f` for a noninteractive recovery batch: interactive `ON_ERROR_STOP` returns to the prompt rather than preventing further operator commands.