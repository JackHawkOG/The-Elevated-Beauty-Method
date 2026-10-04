# Free guide request analytics

In Publishing settings, enable analytics and publish or republish the app.
Replit supplies the tracker; the app does not install its own script. In development,
or when the tracker is missing or blocked, guide requests still work.

| Event | Meaning | Properties |
| --- | --- | --- |
| `guide_form_viewed` | Available request form rendered, once per page mount (not loading/error/unavailable screens). | None |
| `guide_request_submitted` | Valid, consented request submitted; duplicate clicks while in flight are excluded. | `attempt`: `initial`, `retry`, or `check` |
| `guide_request_accepted` | Server recorded provider acceptance from this send attempt. | None |
| `guide_request_deduplicated` | Server returned an already accepted request without another send. | None |
| `guide_request_processing` | Request remains in progress; not an acceptance. | None |
| `guide_request_failed` | Browser could not confirm acceptance. | `reason`: `invalid_request`, `conflict`, `rate_limited`, `unavailable_or_uncertain`, or `unknown` |
| `guide_request_outcome_unknown` | Response lacks the new outcome classification, such as from an older server. Excluded from accepted and deduplicated counts. | None |

## Interpreting counts

- For newly accepted guide requests, use `guide_request_accepted` alone. Keep
  `guide_request_deduplicated` separate, so retries do not inflate new acceptances.
- To understand visitors who obtained an accepted result, inspect analytics'
  visitor counts for accepted and deduplicated events, not their summed event
  totals. One visitor can trigger both, and a request is not a unique person.
- Compare available form views with initial submissions and acceptances to
  understand drop-off. Repeat visits and retries mean simple event-count ratios
  are approximate, not an identity-based conversion ledger.
- Neither acceptance nor deduplication confirms mailbox delivery or PDF reading.
  Errors can be uncertain, not proof nothing was sent. HTTP 503 is deliberately
  grouped as unavailable or uncertain.
- Counts only cover browser-observed results when analytics is present and
  succeeds. Blockers, lost responses, or a closed page can omit events; there is
  no background replay, tracking receipt, or additional guide send.
- Custom events contain no email, IP, request ID, hash, form content, provider
  message, error text, or account identity. Only the fixed categories above are
  passed to the existing safe analytics wrapper.

The approved disclosure appears beside the form and on `/guide-privacy`.
Guide-only consent and existing delivery, retry, and abuse-prevention behavior
remain separate from analytics. No marketing subscription is created.