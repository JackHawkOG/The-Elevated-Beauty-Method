import { afterEach, expect, test, vi } from "vitest";
import { trackRadiantAuditSaved } from "./analytics";

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