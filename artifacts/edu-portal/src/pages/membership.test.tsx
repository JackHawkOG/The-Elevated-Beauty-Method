import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import type { EffectCallback } from "react";

const state = vi.hoisted(() => ({
  offer: { phase: "open", foundingAvailable: true },
  isLoading: false,
  isError: false,
  membership: null as null | {
    kind: "founding" | "standard";
    status: "confirmed" | "forfeited";
    cancellationDate: string | null;
  },
  effects: [] as Array<EffectCallback>,
  invalidateQueries: vi.fn(),
  role: "member",
  cleanup: { total: 0, sessions: [] as Array<{ sessionId: string; queuedAt: string }> },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: EffectCallback) => { state.effects.push(effect); } };
});
vi.mock("@workspace/api-client-react", () => ({
  useGetMembershipOffer: () => ({ data: state.offer, isLoading: state.isLoading, isError: state.isError }),
  useGetMyMembership: () => ({ data: { membership: state.membership }, isPending: false, isError: false }),
  useGetConfirmedMembershipCounts: () => ({ data: { founding: 0, standard: 0 } }),
  useGetMembershipCheckoutCleanupAlerts: () => ({ data: state.cleanup }),
  useCreateMembershipCheckout: () => ({ isPending: false }),
  useCreateMembershipPortal: () => ({ isPending: false }),
  getGetMembershipOfferQueryKey: () => ["membership", "offer"],
  getGetMyMembershipQueryKey: () => ["membership", "me"],
  getGetConfirmedMembershipCountsQueryKey: () => ["membership", "confirmed-counts"],
  getGetMembershipCheckoutCleanupAlertsQueryKey: () => ["membership", "checkout-cleanup-alerts"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }) }));
vi.mock("@clerk/react", () => ({ useUser: () => ({ user: { publicMetadata: { role: state.role } } }) }));
vi.mock("@/components/layout", () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import MembershipPage from "./membership";

function page(phase: string, available: boolean) {
  state.offer = { phase, foundingAvailable: available };
  return renderToStaticMarkup(
    <Router hook={() => ["/membership", () => {}]}>
      <MembershipPage />
    </Router>,
  );
}

test("founding enrollment is shown only while open and places remain", () => {
  state.membership = null;
  const upcoming = page("upcoming", true);
  expect(upcoming).toContain("Enrollment opens October 1");
  expect(upcoming).not.toContain("Continue to secure checkout");
  expect(upcoming).not.toContain("Join at the standard rate");

  const open = page("open", true);
  expect(open).toContain("Founding Member · $24/month");
  expect(open).toContain("Continue to secure checkout");
  expect(open).toContain("Join at the standard rate");

  const soldOut = page("open", false);
  expect(soldOut).toContain("Founding places are all claimed or reserved.");
  expect(soldOut).not.toContain("Continue to secure checkout");
  expect(soldOut).toContain("Join at the standard rate");

  const closed = page("closed", true);
  expect(closed).toContain("founding enrollment window has closed");
  expect(closed).not.toContain("Continue to secure checkout");
  expect(closed).toContain("Join at the standard rate");
});

test("staff see overdue cleanup alerts without checkout links, which clear with the queue", () => {
  state.role = "owner";
  state.cleanup = { total: 1, sessions: [{ sessionId: "cs_test_overdue", queuedAt: "2026-10-01T14:00:00Z" }] };
  const alert = page("open", true);
  expect(alert).toContain("Checkout cleanup needs attention");
  expect(alert).toContain("cs_test_overdue");
  expect(alert).not.toContain("checkout.stripe.com/");
  state.cleanup = { total: 0, sessions: [] };
  expect(page("open", true)).not.toContain("Checkout cleanup needs attention");
  state.cleanup = { total: 1, sessions: [{ sessionId: "cs_test_overdue", queuedAt: "2026-10-01T14:00:00Z" }] };
  state.role = "member";
  expect(page("open", true)).not.toContain("cs_test_overdue");
  state.cleanup = { total: 0, sessions: [] };
});

test("billing return refreshes scheduled cancellation to resumed or ended wording", () => {
  const date = "2030-06-15T12:00:00.000Z";
  state.membership = { kind: "founding", status: "confirmed", cancellationDate: date };
  state.effects.length = 0;
  state.invalidateQueries.mockClear();

  const scheduled = page("open", true);
  expect(scheduled).toContain("membership is active until your scheduled cancellation.");
  expect(scheduled).toContain("Your cancellation takes effect on");
  expect(scheduled).toContain("2030");
  expect(scheduled).toContain("You keep access until then.");

  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { addEventListener, removeEventListener, location: { href: "https://example.test/membership" } });
  try {
    const cleanups = state.effects.map((effect) => effect());
    expect(addEventListener).toHaveBeenCalledWith("pageshow", expect.any(Function));
    const onPageShow = addEventListener.mock.calls.find(([event]) => event === "pageshow")?.[1];
    onPageShow();
    expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["membership", "me"] });
    for (const cleanup of cleanups) cleanup?.();
    expect(removeEventListener).toHaveBeenCalledWith("pageshow", onPageShow);
  } finally {
    vi.unstubAllGlobals();
  }

  state.membership = { kind: "founding", status: "confirmed", cancellationDate: null };
  const resumed = page("open", true);
  expect(resumed).toContain("membership is active.");
  expect(resumed).not.toContain("active until your scheduled cancellation");
  expect(resumed).not.toContain("Your cancellation takes effect on");
  expect(resumed).not.toContain("2030");
  expect(resumed).not.toContain("You keep access until then.");

  state.membership = { kind: "founding", status: "forfeited", cancellationDate: null };
  const ended = page("open", true);
  expect(ended).toContain("membership has ended.");
  expect(ended).not.toContain("membership is active");
  expect(ended).not.toContain("Your cancellation takes effect on");
});
