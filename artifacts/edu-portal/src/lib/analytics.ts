type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
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

const membershipCheckoutReturnKey = "membership_checkout_return";
export function trackMembershipCheckoutStarted(kind: "founding" | "standard", accountId: string | undefined): void {
  try {
    if (accountId) window.sessionStorage.setItem(membershipCheckoutReturnKey, JSON.stringify({ kind, accountId }));
  } catch {
    // Storage may be disabled; analytics must not interrupt checkout.
  }
  trackEvent("membership_checkout_started", { kind });
}

export function trackMembershipEnrollmentConfirmed(kind: "founding" | "standard"): void {
  trackEvent("membership_enrollment_confirmed", { kind });
}

export function trackConfirmedMembershipReturn(
  membership: { kind: "founding" | "standard"; status: "pending" | "confirmed" | "forfeited" } | null | undefined,
  accountId: string | undefined,
): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const returnType = url.searchParams.get("checkout");
  if (returnType === "cancel") {
    try {
      window.sessionStorage.removeItem(membershipCheckoutReturnKey);
    } catch {
      // Storage may be disabled.
    }
    return;
  }
  if (membership?.status !== "confirmed") return;
  if (returnType !== "success") return;

  // A confirmed membership may predate a pasted or bookmarked success URL.
  // Count only a checkout initiated in this tab, then consume that marker.
  try {
    const started = window.sessionStorage.getItem(membershipCheckoutReturnKey);
    window.sessionStorage.removeItem(membershipCheckoutReturnKey);
    if (accountId && started &&
        JSON.stringify({ kind: membership.kind, accountId }) === started) {
      trackMembershipEnrollmentConfirmed(membership.kind);
    }
  } catch {
    // Storage may be disabled; do not count an unverified browser return.
  }
  url.searchParams.delete("checkout");
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // History access must not interrupt the membership page.
  }
}
