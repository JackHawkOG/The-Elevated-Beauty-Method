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

export function trackMembershipCheckoutStarted(kind: "founding" | "standard"): void {
  trackEvent("membership_checkout_started", { kind });
}

export function trackMembershipEnrollmentConfirmed(kind: "founding" | "standard"): void {
  trackEvent("membership_enrollment_confirmed", { kind });
}

export function trackConfirmedMembershipReturn(
  membership: { kind: "founding" | "standard"; status: "pending" | "confirmed" } | null | undefined,
): void {
  if (typeof window === "undefined" || membership?.status !== "confirmed") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("checkout") !== "success") return;

  // The Stripe return URL alone is not proof of payment. Avoid a duplicate on refresh.
  trackMembershipEnrollmentConfirmed(membership.kind);
  url.searchParams.delete("checkout");
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // History access must not interrupt the membership page.
  }
}