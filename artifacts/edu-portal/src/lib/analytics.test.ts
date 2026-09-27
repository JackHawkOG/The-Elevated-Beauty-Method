import { afterEach, expect, test, vi } from "vitest";
import {
  clearAuditVerification, rememberAuditVerification, trackAuditResumptionIfRequested,
  trackAuditVerificationAction, trackConfirmedMembershipReturn, trackMembershipCheckoutStarted,
  trackMembershipEnrollmentConfirmed, trackRadiantAuditSaved,
} from "./analytics";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("Audit analytics sends only the fixed completion kind", () => {
  const track = vi.fn();
  vi.stubGlobal("window", { umami: { track } });
  trackRadiantAuditSaved("first_time");
  trackRadiantAuditSaved("retake");
  expect(track.mock.calls).toEqual([
    ["radiant_audit_saved", { completion_kind: "first_time" }],
    ["radiant_audit_saved", { completion_kind: "retake" }],
  ]);
});

test("Audit verification analytics sends only fixed actions and locations", () => {
  const track = vi.fn();
  vi.stubGlobal("window", { umami: { track } });
  trackAuditVerificationAction("verify_email", "form");
  trackAuditVerificationAction("switch_account", "completion");
  expect(track.mock.calls).toEqual([
    ["radiant_audit_verification_action", { action: "verify_email", location: "form" }],
    ["radiant_audit_verification_action", { action: "switch_account", location: "completion" }],
  ]);
});

test("a normal verified pending save does not count as verification recovery", () => {
  const track = vi.fn();
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    umami: { track },
    sessionStorage: {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    },
  });
  // A verified account can reach the completion page without opening verification.
  trackAuditResumptionIfRequested("account-one", "completion");
  expect(track).not.toHaveBeenCalled();

  // A different account's verification action must not count for this save.
  rememberAuditVerification("account-one");
  trackAuditResumptionIfRequested("account-two", "completion");
  expect(track).not.toHaveBeenCalled();
  clearAuditVerification();
});

test("a confirmed save after the verify-email action counts once without identity or answers", () => {
  const track = vi.fn();
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    umami: { track },
    sessionStorage: {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    },
  });
  rememberAuditVerification("account-one");
  trackAuditResumptionIfRequested("account-one", "completion");
  trackAuditResumptionIfRequested("account-one", "completion");
  expect(track.mock.calls).toEqual([
    ["radiant_audit_resumed_after_verification", { location: "completion" }],
  ]);
  rememberAuditVerification("account-one");
  trackAuditResumptionIfRequested("account-one", "form");
  expect(track).toHaveBeenLastCalledWith("radiant_audit_resumed_after_verification", { location: "form" });
  clearAuditVerification();
});

test("membership analytics sends only the fixed membership kind", () => {
  const track = vi.fn();
  vi.stubGlobal("window", { umami: { track } });
  trackMembershipCheckoutStarted("founding");
  trackMembershipCheckoutStarted("standard");
  trackMembershipEnrollmentConfirmed("founding");
  expect(track.mock.calls).toEqual([
    ["membership_checkout_started", { kind: "founding" }],
    ["membership_checkout_started", { kind: "standard" }],
    ["membership_enrollment_confirmed", { kind: "founding" }],
  ]);
});

test("analytics being missing or throwing cannot interrupt checkout", () => {
  vi.stubGlobal("window", {});
  expect(() => trackMembershipCheckoutStarted("standard")).not.toThrow();
  vi.stubGlobal("window", { umami: { track: () => { throw new Error("blocked"); } } });
  expect(() => trackMembershipEnrollmentConfirmed("standard")).not.toThrow();
});

test("a success redirect counts only after payment confirmation", () => {
  const track = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership?checkout=success" },
    history: { state: null, replaceState },
    umami: { track },
  });

  trackConfirmedMembershipReturn({ kind: "founding", status: "pending" });
  expect(track).not.toHaveBeenCalled();
  trackConfirmedMembershipReturn({ kind: "founding", status: "confirmed" });
  expect(track).toHaveBeenCalledWith("membership_enrollment_confirmed", { kind: "founding" });
  expect(replaceState).toHaveBeenCalledWith(null, "", "/membership");

  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership" },
    history: { state: null, replaceState },
    umami: { track },
  });
  trackConfirmedMembershipReturn({ kind: "founding", status: "confirmed" });
  expect(track).toHaveBeenCalledTimes(1);
});