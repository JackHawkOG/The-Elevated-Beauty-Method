---
name: Billing review notice semantics
description: Distinguish operational review outages from member payment failures
---

Treat persistent billing-review failures as private operational notices, not as evidence that a member missed payments. The default delivery is an in-app owner/admin notice across signed-in pages; external emails require the owner's explicit opt-in and must not notify members.

**Why:** A Stripe lookup or database write outage can prevent a review even when payment succeeded. Describing it as delinquency, or including payment details in a broad notification, would mislead recipients and unnecessarily expose billing information. The existing private owner-alert pattern provides visibility without requiring a membership-page visit.

**How to apply:** Keep general notification text and metadata separate from the detailed staff investigation view. External delivery must retain the operational wording and send only a generic notice with a link to the protected review page.

After an ambiguous external email send, retry only the original immutable payload and key within the provider's deduplication window. Stop rather than rotate the key after that window.

**Why:** Resend retains idempotency keys for 24 hours. A successful external send followed by a lost response or failed local acknowledgement is indistinguishable from a failed send; retrying outside retention can duplicate an alert even with the same key.

**How to apply:** Persist send intent before contacting the provider, allow a safety margin below its retention window, and retain a terminal uncertain outcome rather than starting a fresh attempt for the same failure streak. Opt-out and committed recovery must suppress unsent work; an already-dispatched email cannot be recalled.

Sweep-wide health must have an observation path that does not depend on the failed database. Database persistence alone cannot report a database connection outage.

**Why:** A sweep can fail before it reaches any subscription, and the staff alert query can fail for the same reason. A known operational warning must remain visible without claiming that unavailable individual review data is healthy. Process memory cannot preserve that streak through a restart during the same outage.

**How to apply:** Use a private independent durable store containing only timestamps and attempt counts, with separate development and production records. Explicitly mark individual checks unavailable, and keep role verification mandatory even on degraded startup. Block normal operations until initialization completes; resolve the warning only after a completed sweep. Do not turn non-database startup failures into degraded database operation.

Bound initialization separately from membership writes; do not apply a generic promise timeout to an entire reconciliation or database lock query.

**Why:** A timed-out promise does not cancel its underlying operation. A late transaction could still change access, or a late session-lock acquisition could leak a lock on a released connection.

**How to apply:** Deadlines are safe before writes when late connections are released and late client initialization cannot resume the sweep. For stalls inside database operations, use actual cancellation or passive health observation without clearing the running guard.

Keep invoice-history recovery for ended founding memberships separate from billing-review failure alerts. Staff inspection is read-only and must never restore forfeited access.

**Why:** An ended subscription can already have lost access while its payment-failure reason remains uncertain because invoice history is unavailable. The user explicitly requested a separate staff view without exposing private billing information to members or restoring access.

**How to apply:** Treat pending history as an unresolved explanation, not a new payment failure or an active entitlement. Keep recovery attempts and retry schedules private to authorized billing staff.

Derive invoice-history notices from committed pending recovery state, without a separate alert ledger. A failed notice read must replace stale counts with an explicit unavailable status, never an all-clear.

**Why:** History recovery already commits its pending flag and retry count together. A separate ledger introduces another clearing step that can drift, and an unavailable database cannot prove whether recovery occurred.

**How to apply:** Keep the notice read-only and generic, scope it to the current authorized staff identity, and refetch while staff pages remain open. Do not reuse the independent sweep-health warning as evidence of individual history recovery.