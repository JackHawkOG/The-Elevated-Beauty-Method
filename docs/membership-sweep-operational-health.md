# Membership sweep operational health

The full membership-review sweep records its failure streak independently of the application database in private App Storage. The health record contains only `consecutiveFailures`, `firstFailedAt`, and `lastFailedAt`. Successful recovery writes a JSON `null` tombstone. No member, subscription, invoice, payment, exception, or credential data is stored.

## Storage and visibility

- The API server uses the Replit App Storage sidecar and `PRIVATE_OBJECT_DIR`. There is no public upload/download route for this record.
- Development and production use separate objects under the private `operational-health` prefix. App Storage must remain configured in the deployment environment.
- Generation-conditional writes prevent simultaneous servers from dropping failed attempts or overwriting recovery with an old snapshot.
- The existing owner/admin reconciliation-alert endpoint reads the record before querying the database. If the database is offline, it returns a known prolonged sweep warning with `subscriptionsAvailable: false`, never implying that individual membership checks succeeded.
- Authentication, current staff-role verification, and private/no-store responses remain required. Members and visitors cannot read the warning.

## Outage and recovery

At least three failed attempts spanning 30 minutes are required before a warning is shown. Rapid retries or brief interruptions are suppressed. Restarting the API server does not reset the independently persisted streak.

During database-offline startup, only the existing staff reconciliation-alert route and infrastructure health check are available (the Clerk authentication proxy remains mounted). The health check explicitly reports degraded database availability. All other application operations, including Stripe webhooks, receive a retryable 503; background mutation jobs are not started. Initialization retries serially every 15 minutes. Incompatible schema and non-database startup errors retain their fatal behavior.

Finishing initialization does not clear the warning. A completed full sweep clears the database mirror and independent record. Targeted subscription retries do not clear or advance sweep health.

If App Storage is also unavailable, the server logs a generic operational error and retains known local failure state, with the database mirror as an additional fallback where available. Simultaneous outages of both independent services cannot guarantee restart durability. Storage-provider responses and arbitrary exception data are not written to the health record.

No additional email notifications are sent.

## Verification

`pnpm run test:membership` includes isolated tests for restart while the database remains offline, recovered staff-only HTTP responses, startup write blocking, recovery, brief-outage suppression, conditional-write conflicts, private environment separation, malformed records, and storage failures. Those tests use disposable local mocks; they do not modify the running app's App Storage health record.