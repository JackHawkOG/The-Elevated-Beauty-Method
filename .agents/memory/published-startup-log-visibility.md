---
name: Published startup log visibility
description: Observed limits of API startup log inspection in published deployment logs.
---

On September 28, 2026, deployment log queries returned platform startup events and the first API health-check request, but not the API's earlier Pino startup lines. A query for the previous day's startup entries returned none; this does not establish whether those entries were never indexed or had expired.

**Why:** A one-time repair result cannot be reconstructed from a subsequent idempotent run. Missing early logs are not evidence that the repair did not run.

**How to apply:** For future startup-only outcomes that operators must inspect, emit a structured summary after the service begins answering health checks and check its presence promptly after publishing. Do not claim historical repair IDs from later empty results.