---
name: Audit save and autosave
description: Why a confirmed Audit save must stop draft writes until the form unmounts
---

Once a completed Audit has been confirmed, the submitting form must not write another draft before it unmounts.

**Why:** Clearing the browser draft after a successful response is not enough if a form change effect runs again during navigation. It can recreate the completed answers as an unfinished draft, especially when completion timestamps in tests or remote systems do not line up with local browser time.

**How to apply:** Gate form-driven draft persistence once the save is confirmed, but do not gate it after failed saves: their answers and submission receipt must remain available for retry.

Transition regressions should hold routing after save confirmation and edit the still-mounted real form, checking storage before the next form loads.

**Why:** A blank form after navigation does not prove no late write occurred; restoration cleanup can mask it. A controlled navigation hold makes the narrow save-to-unmount interval deterministic without adding production test hooks.

**How to apply:** Keep the hold in the isolated browser harness, run beyond the autosave debounce, and verify both local storage and online draft writes. Temporarily removing the confirmed-save guard should make this check fail.