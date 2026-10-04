---
name: Paused browser query notifications
description: Real network responses and React Query rendering use different clocks in Playwright clock tests.
---

A request count increasing on a paused browser clock does not mean its response has rendered. Real network completion and React Query's timer-batched notifications must both settle before checking the refreshed UI.

**Why:** A focus check can pass while the corresponding interval check sees missing rows or a still-fetching page because its paused clock has not delivered the render notification.

**How to apply:** When testing focus or polling with Playwright's clock and real HTTP responses, wait for the response and advance the browser clock enough to deliver the resulting notifications. Do not change the application's refresh logic to compensate for a test-clock artifact.