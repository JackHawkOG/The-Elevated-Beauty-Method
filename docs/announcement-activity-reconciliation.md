# Legacy announcement feed reconciliation

The API startup repair considers only announcements without an actor ID and request key (legacy posts). It inserts an activity item at the original announcement timestamp **only** when the announcement's title is unique among all announcements and no announcement activity has that title. The comparison tolerates the old variation in spacing before `™`. A transaction lock prevents two API instances from repairing the same gap concurrently. Repeated startups see the inserted item and do not insert another.

Any repeated title, multiple matching feed entries, or a single matching feed entry with a different author or a timestamp outside five minutes after the post is **not** repaired. These cases are logged with announcement IDs, candidate activity IDs, and a reason under `Ambiguous legacy announcement activity requires manual review`. Before taking manual action, compare the full announcement and activity records in the relevant database; do not assume a matching title alone establishes identity.

## Review on September 27, 2026

| Database | Announcement ID | Evidence | Result |
| --- | --- | --- | --- |
| Development | 2 | Unique title, no matching announcement activity | Repaired; new activity ID 11, dated to the announcement |
| Development | 1, 3 | One title-and-time-matching feed entry each (activity IDs 3, 7), but the feed author is `Nikki` while the announcement author is `Nikki — Blushing Beauty By Nikki` | Left unchanged for manual review |
| Production (read-only inspection) | 2 | Unique title, no matching announcement activity | Still missing; expected to be repaired on the next API publish if its actor ID and request key are null |
| Production (read-only inspection) | 1, 3 | Same author mismatch as development, with activity IDs 3 and 7 | Preserve historical feed display names; do not create replacement entries |

The production database cannot be written through the read-only inspection connection. Its legacy actor/request-key columns could not be independently confirmed in that inspection.

## Published verification on September 27, 2026

After the updated API was published, the production announcements schema includes `actor_id` and `request_key`. Read-only production counts show exactly one title-matching announcement activity each for announcement 1 (activity 3), announcement 2 (activity 11), and announcement 3 (activity 7). The public `/api/dashboard/recent-activity` response also includes those three activity IDs exactly once each. No manual production insert was needed.

The available deployment startup logs did not include the `Legacy announcement activity reconciliation` summary (`repairedIds`/`review`), so the log's exact repair result could not be independently confirmed. Neither announcement gained a duplicate feed entry. The author-label discrepancy for announcements 1 and 3 was subsequently evaluated as a historical display-name variation, while exact source attribution remains for staff review (below). A later repeat run cannot reconstruct the original `repairedIds`: already-repaired rows are skipped.

## Finding the result after a future publish

Deployment logs fetched on September 28 included platform startup lines and an API `request completed` entry for `/api/healthz`, but not the API's pre-listen reconciliation summary or `Server listening` entry. The September 27 startup entries were not returned by the available deployment-log query; whether they were never indexed or have since expired could not be determined. Do not infer the original repair result from a later run.

The API now holds the committed repair result until the first successful `/api/healthz` response (the configured production startup health check), then writes one `Legacy announcement activity reconciliation` log entry with `repairedIds` and `review`. Ambiguous cases also produce `Ambiguous legacy announcement activity requires manual review`. Neither result is returned to the health-check caller. Search the API's **Publishing logs** for these exact messages immediately after publishing, and preserve the entry externally if it is needed beyond the deployment log window. An empty `repairedIds` on later startups means there was nothing left to insert on *that* run; it is not evidence about a prior publish.

## Published log verification on October 1, 2026

The existing successful production deployment was inspected without publishing or restarting it. Publishing logs show API startup at `2026-10-01T21:28:24.518Z`, followed by the first successful `/api/healthz` request at `21:28:34.397Z` (request ID 1, PID 20). The committed summary appears one millisecond later:

```text
[2026-10-01T21:28:34.398Z INFO] Legacy announcement activity reconciliation {"pid":20,"hostname":"localhost","repairedIds":[],"review":[{"announcementId":1,"activityIds":[3],"reason":"feed entry has a different author or timestamp"},{"announcementId":3,"activityIds":[7],"reason":"feed entry has a different author or timestamp"}]}
```

The corresponding `Ambiguous legacy announcement activity requires manual review` warning is also indexed at `21:28:34.398Z`. Both required summary fields are present: this startup inserted nothing, and retained announcements 1 and 3 for review. This does not reconstruct the September 27 repair result or change the historical author-label decision below.

Two subsequent production health checks returned HTTP 200 with `{"status":"ok"}`. Publishing logs record them at `23:48:24.307Z` and `23:48:24.428Z` (request IDs 185 and 186, the same PID 20), with no reconciliation summary in that interval. A separate exact-message search from this startup returned only the single `21:28:34.398Z` summary. Production indexing and once-per-process reporting are therefore confirmed for this observed startup; no collector investigation was needed.

## Historical author-label decision on September 28, 2026

Read-only inspection of the **full production records** confirms:

| Announcement | Feed item | Post author / feed actor | Post / feed time (UTC) | Other evidence |
| --- | --- | --- | --- | --- |
| 1, `Welcome to The Elevated Beauty Method™` | 3, same title, `posted` | `Nikki — Blushing Beauty By Nikki` / `Nikki` | Aug 7, 15:42:46.363009 / 15:42:49.563089 | Post body ends “With love, Nikki”; post is pinned. |
| 3, `The Elevated Beauty Method™ is officially open` | 7, same title, `posted` | `Nikki — Blushing Beauty By Nikki` / `Nikki` | Aug 7, 15:42:46.363009 / 15:42:49.563089 | Post body identifies the next chapter for BBBN. |

Both announcements have null `actor_id` and `request_key`; both feed entries have null `source_announcement_id` and review evidence. The other legacy announcement (2) now has a single feed entry (11). There is exactly one feed entry with each title, and feed entries 3 and 7 share the timestamp of the original seeded activity batch. These details support treating `Nikki` as the older short display name for the announcement author, **not** as proof that a second feed entry is missing. Preserve the historical feed actor and the announcement byline as written; do not rewrite either name or insert another activity row.

This decision resolves the *author-label discrepancy*, not source attribution. A shared title and timestamps (even with the post body identifying Nikki) do not independently establish which unlinked feed row was generated by which post. Leave `source_announcement_id` null and keep the records available in the staff review queue until an independent publication record or equivalent evidence identifies each exact pairing. If that evidence becomes available, use the existing staff review flow to attach the ID with its evidence, without creating or replacing feed entries. The startup repair must continue to leave these mismatches untouched.
