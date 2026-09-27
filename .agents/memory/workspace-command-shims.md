---
name: Workspace command shims
description: Distinguishing a launcher permission error from a test failure
---

An EACCES error spawning a package command means the check has not started; it does not imply that the tests or compiler failed.

**Why:** Generated command shims may have different permissions from the underlying tool entry points in this environment.

**How to apply:** Diagnose the launcher separately before interpreting the check result; verify that the intended validation actually runs.