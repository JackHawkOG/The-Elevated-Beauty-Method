# The Elevated Routine email sender verification

Approved sender: **The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>**.

Approved Reply-To: **hello@elevatedbeautymethod.com**. The owner confirmed receipt of the setup-test email and supplied a Gmail screenshot showing the message labeled **Inbox**.

## Google Workspace receiving setup

The owner is setting up the domain in Google Workspace and confirmed saving Google's DNS additions in Replit. Public DNS now returns:

- Root-domain MX: priority **1**, target **smtp.google.com**.
- Google's domain-ownership verification TXT record.
- Root-domain SPF TXT: `v=spf1 include:_spf.google.com ~all`.

The Resend MX at **send.elevatedbeautymethod.com** remains intact with priority **10** and target **feedback-smtp.us-east-1.amazonses.com**. Google's root-domain receiving records and Resend's subdomain sending records coexist; do not delete the `send` MX when configuring Google.

Cloudflare and Google Public DNS both return the expected root-domain MX, Google ownership-verification TXT, and Google SPF TXT. The owner's Google Workspace screenshot shows **MX, SPF, and Google's DKIM all Complete**. Google's mail server accepted the setup-test email to `hello`, and the owner subsequently confirmed receipt with a screenshot showing the message in **Inbox**, not spam. The setup test verifies this sending and receiving path; it is not an automated guide-delivery test.

## Resend sending setup

The domain was added to Resend for **sending only**. Receiving is disabled; this setup does not create an inbox. Open and click tracking are disabled. The owner confirmed adding all four DNS records in Replit. Public DNS lookups return the expected values. Resend now reports **all four records and the domain as `verified`**, with sending enabled. Domain verification is complete; actual guide delivery remains unimplemented and untested.

Add these records wherever the authoritative DNS for `elevatedbeautymethod.com` is managed. These are **public DNS verification values**, not the secret Resend API key.

The owner purchased the domain through Replit. Manage its records in **Publishing → Domains → elevatedbeautymethod.com → Edit → Add DNS Record**. Replit's domain-purchasing documentation explicitly describes TXT and MX support. If the editor does not offer CNAME for the fourth record, do not substitute another record type; resolve that editor limitation before treating verification as complete.

| Type | Host / name | Value / target | Priority | TTL |
| --- | --- | --- | --- | --- |
| TXT | `resend._domainkey` | See the DKIM value below | — | Auto/default |
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Auto/default |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — | Auto/default |
| CNAME | `rsend` | `send.forge.rmta.net` | — | Auto/default |

DKIM TXT value (paste as one continuous string):

```text
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDcoNlqyOeKdMiqqONjJ6PWR94FWiQYK0cWOB8xcgSKm77wrO4lmHrqYzEmRGY8lqCUOyX8yW9iyrGqPwMdtr24AWIsYWZ0NbU+rvY5V/W8kg7qc9qUwDd3MDj0JReTRJlc7pGPpE6nVnQOKcaJV/8dJ5BjVgkdNp0ufE9RVFfTHQIDAQAB
```

## Setup-test delivery evidence

The owner approved one plain setup-test email, with no guide attachment or marketing subscription. On **2026-10-02 at 10:33:49 UTC**, Resend accepted the send from the approved From identity to `hello@elevatedbeautymethod.com` with subject **Email setup test — The Elevated Beauty Method ™**. Email ID: `01a0fc2d-67bd-732c-a53c-04aa7a2c3428`. Retrieving that message returned **`last_event: delivered`**.

The owner subsequently confirmed “It worked” and supplied a screenshot showing this test message in Gmail's **Inbox**. This confirms both Google's server acceptance and inbox placement for this one test. It is a manual infrastructure test, not an implemented guide opt-in or automated delivery flow. Do not resend the test without further approval.

## Safety

- Do not change nameservers, website A/CNAME records, or root-domain mailbox MX records for this setup.
- The MX above belongs at **`send.elevatedbeautymethod.com`**, not at the root (`@`).
- Some hosts append the domain automatically; in those hosts enter the short names in the table, not the full name twice.
- Check for an existing record at each exact host before adding anything. Do not overwrite a conflicting service's record without review.
- After records are saved, request verification in Resend and check actual status. A saved record is not proof of successful verification.
- Re-fetch Resend's live records if the domain is recreated; its DKIM value may change.

The owner approved guide-only consent and delivery, without a marketing subscription, and has approved the corrected **The Elevated Routine** PDF. On 2026-10-02, the owner also approved the implemented signup/privacy/delivery flow, one PDF delivery test to the approved inbox, and library inclusion after verification. The actual guide-delivery endpoint succeeded and Resend reported delivery before the free library was enabled. None of these approvals authorize marketing emails.

## Automated guide-delivery evidence — 2026-10-02

- Permission: **“Approve the flow and send one test email.”** This explicitly covered one guide-only PDF test to `hello@elevatedbeautymethod.com`.
- The development app's `POST /api/routine-guide/claim` accepted explicit guide-only consent and returned HTTP 200 with `status: sent`, after the database recorded provider acceptance.
- From: `The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>`; Reply-To and test recipient: `hello@elevatedbeautymethod.com`; subject: **The Elevated Routine**.
- The private PDF attachment is named `the-elevated-routine.pdf` and matches the approved review PDF byte-for-byte. Its SHA-256 is `d52221527813a33ad7e6c90e3071b3b4927ae0d95cf6b7eac9c20e99147b4f44`.
- Resend's read-only email lookup reported message `01a0fcd7-1ad1-7e6e-9c80-b584b6540f66`, created `2026-10-02 13:39:11.018000+00`, with `last_event: delivered`.
- This confirms automated recipient-server delivery. The owner has not separately confirmed this PDF test's Gmail Inbox placement; the earlier plain setup test's Inbox screenshot is separate evidence.
- No Resend audience contact, ongoing marketing subscription, five-part sequence, or production deployment was created by this test. Library publication was enabled only after this delivery result.
- After browser verification submitted an explicit repeat claim to the same approved address, a final read-only Resend lookup still showed only this one guide email (`has_more: false`), with `delivered` status. The repeat request reused the existing accepted delivery rather than generating another email.