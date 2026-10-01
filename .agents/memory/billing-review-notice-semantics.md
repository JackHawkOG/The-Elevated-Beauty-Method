---
name: Billing review notice semantics
description: Distinguish operational review outages from member payment failures
---

Treat persistent billing-review failures as private operational notices, not as evidence that a member missed payments. The default delivery is an in-app owner/admin notice across signed-in pages, not a member message or an email.

**Why:** A Stripe lookup or database write outage can prevent a review even when payment succeeded. Describing it as delinquency, or including payment details in a broad notification, would mislead recipients and unnecessarily expose billing information. The existing private owner-alert pattern provides visibility without requiring a membership-page visit.

**How to apply:** Keep general notification text and metadata separate from the detailed staff investigation view. If external delivery is added later, retain the operational wording and send only a generic notice with a link to the protected review page.