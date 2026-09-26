# Task note: sharpen the logo in Clerk emails

**Status:** Pending — no email branding has been changed.

## Goal

Replace the blurry, outdated logo shown in The Elevated Beauty Method account and security emails (see `attached_assets/Email_logo_blurry_1790416182807.png`) with the current logo, rendered cleanly at its actual display size.

## Assets

- Preferred email-ready source: `artifacts/edu-portal/public/brand/tebm-master-logo-1200x600.png` (cream background, 1200 × 600). Use at a much smaller displayed width to retain sharpness.
- Alternate source: `artifacts/edu-portal/public/brand/tebm-master-logo-1920x1080.png`.
- A true-vector SVG is saved at `artifacts/edu-portal/public/brand/tebm-master-logo-vector.svg`, but it is solid black and may not render reliably in email clients. Prefer a high-resolution PNG for email.

## When completing

1. Identify the Clerk-controlled application branding or email-template logo responsible for the old square logo; the `ClerkProvider` logo in the website code does **not** control sent emails.
2. Replace that image with the current logo. If the setting requires a square icon, prepare a crisp square version from the current logo rather than stretching the landscape image.
3. Check both Clerk Development and Production instances if emails are sent from both; changes in one instance do not automatically update the other.
4. Preview or send a test email if available. Confirm the logo is legible, not blurry or distorted, and that spacing and contrast look right in both desktop and mobile email clients.

Do not consider this task complete merely because the website's sign-in page logo was updated.