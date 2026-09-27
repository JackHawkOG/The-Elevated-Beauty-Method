---
name: Clerk UI email-code timing
description: Avoiding an early OTP submission in real Clerk browser sign-in checks
---

When exercising Clerk's visible email-code sign-in with a test email, wait for successful first-factor preparation before filling the code. The OTP field may auto-submit immediately when filled.

**Why:** Clerk can show the code field before the factor is ready; entering the code then can produce a misleading verification failure.

**How to apply:** Set up the Clerk testing token for the browser context, await the successful preparation response after continuing past the email field, then enter the test code. Do not submit the OTP again if the field auto-submits.