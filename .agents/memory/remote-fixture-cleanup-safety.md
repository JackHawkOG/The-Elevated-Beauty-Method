---
name: Remote fixture cleanup safety
description: Why remote cleanup refusals preserve partial progress rather than promise cross-service rollback.
---

Development fixture cleanup must stop explicitly when ownership verification changes or becomes unavailable, even after local deletion or an earlier remote deletion has succeeded. Do not undo completed remote work or silently treat failed verification as absence. An unchanged, still-marked identity can authorize a fresh retry.

**Why:** Database, Clerk, and Stripe operations are not one transaction. Cancellation changes Stripe-owned timestamps, and a successful customer deletion removes the records later checks would otherwise inspect. Pretending that every refusal rolls everything back, or allowing arbitrary changes as retry progress, would be misleading and unsafe.

**How to apply:** Distinguish cleanup's confirmed mutations from external edits, verify again at each destructive boundary, and report partial progress through explicit errors. Fresh reads reduce the race window but do not provide conditional deletion or atomicity across providers. Do not reuse development-only cleanup as a production account-deletion flow.