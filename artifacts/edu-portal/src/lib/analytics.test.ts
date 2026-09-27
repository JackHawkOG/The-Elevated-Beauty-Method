import { afterEach, expect, test, vi } from "vitest";
import { trackConfirmedMembershipReturn, trackMembershipCheckoutStarted, trackMembershipEnrollmentConfirmed, trackRadiantAuditSaved } from "./analytics";

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