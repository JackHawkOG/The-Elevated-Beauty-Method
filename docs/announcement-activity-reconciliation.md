# Legacy announcement feed reconciliation

The API startup repair considers only announcements without an actor ID and request key (legacy posts). It inserts an activity item at the original announcement timestamp **only** when the announcement's title is unique among all announcements and no announcement activity has that title. The comparison tolerates the old variation in spacing before `™`. A transaction lock prevents two API instances from repairing the same gap concurrently. Repeated startups see the inserted item and do not insert another.

Any repeated title, multiple matching feed entries, or a single matching feed entry with a different author or a timestamp outside five minutes after the post is **not** repaired. These cases are logged with announcement IDs, candidate activity IDs, and a reason under `Ambiguous legacy announcement activity requires manual review`. Before taking manual action, compare the full announcement and activity records in the relevant database; do not assume a matching title alone establishes identity.

## Review on September 27, 2026

| Database | Announcement ID | Evidence | Result |
| --- | --- | --- | --- |
| Development | 2 | Unique title, no matching announcement activity | Repaired; new activity ID 11, dated to the announcement |
| Development | 1, 3 | One title-and-time-matching feed entry each (activity IDs 3, 7), but the feed author is `Nikki` while the announcement author is `Nikki — Blushing Beauty By Nikki` | Left unchanged for manual review |
| Production (read-only inspection) | 2 | Unique title, no matching announcement activity | Still missing; expected to be repaired on the next API publish if its actor ID and request key are null |
| Production (read-only inspection) | 1, 3 | Same author mismatch as development, with activity IDs 3 and 7 | Leave unchanged for manual review |

The production database cannot be written through the read-only inspection connection. Its legacy actor/request-key columns could not be independently confirmed in that inspection. After publishing the updated API, inspect its startup log for `repairedIds` and `review`, and verify announcement 2 has exactly one activity row. If it is not repaired, inspect its actor ID and request key before taking any manual action. Do not manually insert production rows based only on this development result.