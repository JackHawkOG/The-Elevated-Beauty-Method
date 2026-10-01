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

test("a success redirect counts only its server-confirmed session without browser storage", () => {
  const track = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership?checkout=success#checkout_session_id=cs_new" },
    history: { state: null, replaceState },
    umami: { track },
    get sessionStorage() { throw new Error("blocked"); },
  });

  trackConfirmedMembershipReturn({ kind: "founding", status: "pending", checkoutSessionId: "cs_new" });
  expect(track).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
  trackConfirmedMembershipReturn({ kind: "founding", status: "confirmed", checkoutSessionId: "cs_new" });
  expect(track).toHaveBeenCalledWith("membership_enrollment_confirmed", { kind: "founding" });
  expect(replaceState).toHaveBeenCalledWith(null, "", "/membership");
  expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(track.mock.invocationCallOrder[0]);

  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership" },
    history: { state: null, replaceState },
    umami: { track },
  });
  trackConfirmedMembershipReturn({ kind: "founding", status: "confirmed", checkoutSessionId: "cs_new" });
  expect(track).toHaveBeenCalledTimes(1);
});

test.each(["", "#checkout_session_id=cs_old"])("a stale success link %s cannot count an unrelated confirmed membership even with an old marker", hash => {
  const track = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: `https://example.com/membership?checkout=success${hash}` },
    history: { state: null, replaceState },
    umami: { track },
    sessionStorage: {
      getItem: () => JSON.stringify({ kind: "standard", accountId: "account-one" }),
    },
  });
  trackConfirmedMembershipReturn({ kind: "standard", status: "confirmed", checkoutSessionId: "cs_new" });
  expect(track).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledWith(null, "", "/membership");
});

test("history failure cannot expose correlation to analytics or interrupt the page", () => {
  const track = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership?checkout=success#checkout_session_id=cs_new" },
    history: { state: null, replaceState: () => { throw new Error("blocked"); } },
    umami: { track },
  });
  expect(() => trackConfirmedMembershipReturn({ kind: "standard", status: "confirmed", checkoutSessionId: "cs_new" })).not.toThrow();
  expect(track).not.toHaveBeenCalled();
});

test("a normal membership visit and a cancel return do not count enrollment", () => {
  const track = vi.fn();
  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership" },
    history: { state: null, replaceState: vi.fn() },
    umami: { track },
  });
  trackConfirmedMembershipReturn({ kind: "standard", status: "confirmed", checkoutSessionId: "cs_new" });
  vi.stubGlobal("window", {
    location: { href: "https://example.com/membership?checkout=cancel#checkout_session_id=cs_new" },
    history: { state: null, replaceState: vi.fn() },
    umami: { track },
  });
  trackConfirmedMembershipReturn({ kind: "standard", status: "confirmed", checkoutSessionId: "cs_new" });
  expect(track).not.toHaveBeenCalled();
});