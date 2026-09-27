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