---
name: Published startup log visibility
description: Observed limits of API startup log inspection in published deployment logs.
---

On September 28, 2026, deployment log queries returned platform startup events and the first API health-check request, but not the API's earlier Pino startup lines. A query for the previous day's startup entries returned none; this does not establish whether those entries were never indexed or had expired.

**Why:** A one-time repair result cannot be reconstructed from a subsequent idempotent run. Missing early logs are not evidence that the repair did not run.

**How to apply:** For future startup-only outcomes that operators must inspect, emit a structured summary after the service begins answering health checks and check its presence promptly after publishing. Do not claim historical repair IDs from later empty results.

Production inspection on October 1, 2026 confirmed that the post-health-response summary is indexed, while repeated health checks in the same process do not repeat it. This supports the post-readiness reporting approach; it does not establish why earlier pre-listen entries were unavailable.

For startup repairs whose exact outcomes must outlive log retention, persist each outcome atomically with its repairs, including empty outcomes; retain historical IDs even when source records are later deleted. Do not reconstruct a missing historical outcome from current state.

**Why:** Readiness logging only improves visibility during the log window. An idempotent rerun cannot recover which rows an earlier run repaired, and writing evidence after commit risks losing it permanently if the process stops between the two operations.

**How to apply:** Treat the archive as an outcome history, not a latest-status slot or proof that the rest of startup succeeded. Restrict evidence retrieval to verified staff and keep health responses free of repair details.