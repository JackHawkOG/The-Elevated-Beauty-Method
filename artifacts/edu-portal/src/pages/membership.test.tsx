import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";

const state = vi.hoisted(() => ({
  offer: { phase: "open", foundingAvailable: true },
  isLoading: false,
  isError: false,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetMembershipOffer: () => ({ data: state.offer, isLoading: state.isLoading, isError: state.isError }),
  useGetMyMembership: () => ({ data: { membership: null } }),
  useGetConfirmedMembershipCounts: () => ({ data: { founding: 0, standard: 0 } }),
  useCreateMembershipCheckout: () => ({ isPending: false }),
  useCreateMembershipPortal: () => ({ isPending: false }),
  getGetMembershipOfferQueryKey: () => ["membership", "offer"],
  getGetMyMembershipQueryKey: () => ["membership", "me"],
  getGetConfirmedMembershipCountsQueryKey: () => ["membership", "confirmed-counts"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@clerk/react", () => ({ useUser: () => ({ user: null }) }));
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
