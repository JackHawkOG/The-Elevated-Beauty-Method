import type { RoutineGuideClaimResult } from "@workspace/api-client-react";
import { trackEvent } from "./analytics";

// No identity, request correlations, form values, or provider messages belong here.
export const GUIDE_ANALYTICS_DISCLOSURE = "When site analytics is enabled, we use anonymous events to count form views, submission attempts, accepted requests, deduplicated retries, processing responses, and failures. We do not send your email address, IP address, request ID, hashes, or anything you type into this form to analytics. An accepted request means our email provider accepted the message for delivery—not that it reached your mailbox. These measurements do not subscribe you to marketing or trigger additional emails.";

export function trackGuideFormViewed(): void {
  trackEvent("guide_form_viewed");
}

export function trackGuideSubmitted(attempt: "initial" | "retry" | "check"): void {
  trackEvent("guide_request_submitted", { attempt });
}

export function trackGuideResult(result: Pick<RoutineGuideClaimResult, "status" | "outcome">): void {
  if (result.status === "processing") {
    trackEvent("guide_request_processing");
  } else if (result.status === "sent" && result.outcome === "accepted") {
    trackEvent("guide_request_accepted");
  } else if (result.status === "sent" && result.outcome === "deduplicated") {
    trackEvent("guide_request_deduplicated");
  } else {
    // Older servers cannot distinguish acceptance from deduplication.
    trackEvent("guide_request_outcome_unknown");
  }
}

export function trackGuideFailure(error: unknown): void {
  const status = (error as { status?: unknown } | null)?.status;
  const reason = status === 400 ? "invalid_request" : status === 409 ? "conflict"
    : status === 429 ? "rate_limited" : status === 503 ? "unavailable_or_uncertain" : "unknown";
  trackEvent("guide_request_failed", { reason });
}