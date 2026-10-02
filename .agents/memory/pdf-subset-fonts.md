---
name: PDF subset font editing
description: Why extracted PDF fonts may fail when inserting revised text
---

Use full licensed fonts for new text rather than assuming an embedded PDF font has every glyph its family normally supports.

**Why:** Embedded fonts can be subsets containing only characters used in the source. Reusing those bytes for revised copy can silently produce missing letters even when the insertion reports success.

**How to apply:** After any PDF text replacement, inspect extracted text and rendered pages. Retain the original PDF, fail on text-box overflow, and use full fonts with their license for every changed face, including display fonts. A letter present in the source's italic face may be absent from its regular-face subset. Reject NUL and replacement characters in extracted text rather than trusting a successful insertion. For text over gradients, preserve vector artwork and avoid opaque redaction fills.