import { claimMembershipConversion } from "@workspace/api-client-react";

type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void | Promise<unknown>;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    const pending = window.umami?.track(name, data);
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Analytics must never interrupt the app.
  }
}

export function trackRadiantAuditSaved(completionKind: "first_time" | "retake"): void {
  trackEvent("radiant_audit_saved", { completion_kind: completionKind });
}

export function trackAuditDraftConflictDisplayed(): void {
  trackEvent("radiant_audit_draft_conflict_displayed");
}

export function trackAuditDraftConflictResolved(choice: "local" | "online" | "discard"): void {
  trackEvent("radiant_audit_draft_conflict_resolved", { choice });
}

type AuditVerificationLocation = "form" | "completion";
const auditVerificationKey = "radiant_audit_verification_account";

export function trackAuditVerificationAction(
  action: "verify_email" | "switch_account",
  location: AuditVerificationLocation,
): void {
  trackEvent("radiant_audit_verification_action", { action, location });
}

// Local-only marker: never send an account ID, email, or answers to analytics.
export function rememberAuditVerification(accountId: string): void {
  try {
    window.sessionStorage.setItem(auditVerificationKey, accountId);
  } catch {
    // Storage may be disabled; analytics must not interrupt the Audit.
  }
}

export function clearAuditVerification(): void {
  try {
    window.sessionStorage.removeItem(auditVerificationKey);
  } catch {
    // Storage may be disabled.
  }
}

export function trackAuditResumptionIfRequested(accountId: string, location: AuditVerificationLocation): void {
  try {
    if (window.sessionStorage.getItem(auditVerificationKey) !== accountId) return;
  } catch {
    return;
  }
  trackEvent("radiant_audit_resumed_after_verification", { location });
  clearAuditVerification();
}

export function trackMembershipCheckoutStarted(kind: "founding" | "standard"): void {
  trackEvent("membership_checkout_started", { kind });
}

export function trackMembershipEnrollmentConfirmed(kind: "founding" | "standard"): void {
  trackEvent("membership_enrollment_confirmed", { kind });
}

export async function trackConfirmedMembershipReturn(
  membership: { kind: "founding" | "standard"; status: "pending" | "confirmed" | "forfeited"; checkoutSessionId?: string | null } | null | undefined,
): Promise<void> {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const returnType = url.searchParams.get("checkout");
  if (membership?.status !== "confirmed") return;
  if (returnType !== "success") return;

  const fragment = new URLSearchParams(url.hash.slice(1));
  const sessionId = fragment.get("checkout_session_id");
  const matches = Boolean(sessionId && membership.checkoutSessionId === sessionId);
  // Never forward the private session correlation to analytics. Remove it
  // before tracking, and consume the return so polls and refreshes cannot count it.
  fragment.delete("checkout_session_id");
  url.hash = fragment.toString();
  url.searchParams.delete("checkout");
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Fail closed if the private correlation cannot be removed before tracking.
    return;
  }
  if (!matches || !sessionId || !window.umami) return;
  try {
    const receipt = await claimMembershipConversion({ checkoutSessionId: sessionId });
    // Server-derived fixed kinds only; never forward receipt or checkout identity.
    if (receipt.kind === membership.kind && (receipt.kind === "founding" || receipt.kind === "standard")) {
      trackMembershipEnrollmentConfirmed(receipt.kind);
    }
  } catch {
    // A lost response may have consumed the receipt. Never assume permission.
    // Analytics failure must not interfere with membership access.
  }
}
