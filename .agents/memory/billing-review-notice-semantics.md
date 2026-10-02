---
name: Billing review notice semantics
description: Distinguish operational review outages from member payment failures
---

Treat persistent billing-review failures as private operational notices, not as evidence that a member missed payments. The default delivery is an in-app owner/admin notice across signed-in pages, not a member message or an email.

**Why:** A Stripe lookup or database write outage can prevent a review even when payment succeeded. Describing it as delinquency, or including payment details in a broad notification, would mislead recipients and unnecessarily expose billing information. The existing private owner-alert pattern provides visibility without requiring a membership-page visit.

**How to apply:** Keep general notification text and metadata separate from the detailed staff investigation view. If external delivery is added later, retain the operational wording and send only a generic notice with a link to the protected review page.

Sweep-wide health must have an observation path that does not depend on the failed database. Database persistence alone cannot report a database connection outage.

**Why:** A sweep can fail before it reaches any subscription, and the staff alert query can fail for the same reason. A known operational warning must remain visible without claiming that unavailable individual review data is healthy. Local outage state is necessarily lost on process restart while the database remains unreachable; durable independent monitoring would be a separate reliability improvement.

**How to apply:** Preserve known outage metadata locally during database unavailability, explicitly mark individual checks unavailable, and keep role verification mandatory even on the degraded response path.

Keep invoice-history recovery for ended founding memberships separate from billing-review failure alerts. Staff inspection is read-only and must never restore forfeited access.

**Why:** An ended subscription can already have lost access while its payment-failure reason remains uncertain because invoice history is unavailable. The user explicitly requested a separate staff view without exposing private billing information to members or restoring access.

**How to apply:** Treat pending history as an unresolved explanation, not a new payment failure or an active entitlement. Keep recovery attempts and retry schedules private to authorized billing staff.