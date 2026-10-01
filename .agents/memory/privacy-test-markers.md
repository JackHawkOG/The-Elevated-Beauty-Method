---
name: Privacy test markers
description: Avoid false leaks when observing account-specific content across switches
---

Use non-overlapping markers for the former and current accounts when a privacy check observes text using substring matching. Appending an account suffix to the former account's full marker is not safe.

**Why:** The legitimate second account's course title can contain the full first account title, so both a mutation observer and a negative text assertion report a leak even though the displayed course is correct.

**How to apply:** Choose distinct prefixes or exact identity/heading comparisons for account-switch checks. Keep fixture ownership recognition consistent with any changed markers, and preserve strict rejection of unexpected course or progress data.