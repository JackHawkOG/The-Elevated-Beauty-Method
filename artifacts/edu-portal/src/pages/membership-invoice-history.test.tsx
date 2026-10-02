import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";

const state = vi.hoisted(() => ({
  role: "owner", userId: "owner-a", loaded: true, error: false, pending: false,
  data: {
    memberships: [{
      checkoutId: 42, memberId: "private-member", subscriptionId: "sub_private",
      retryAttempts: 4, nextRetryAt: "2026-10-03T12:00:00Z" as string | null,
    }],
    nextCursor: null as number | null,
  },
  query: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({
    isLoaded: state.loaded,
    user: state.userId ? { id: state.userId, publicMetadata: { role: state.role } } : null,
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  getGetPendingMembershipInvoiceHistoryQueryKey: () => ["pending-history"],
  useGetPendingMembershipInvoiceHistory: (...args: unknown[]) => {
    state.query(...args);
    return { data: state.data, isError: state.error, isPending: state.pending, isFetching: false, refetch: vi.fn() };
  },
}));
vi.mock("@/components/layout", () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/pages/not-found", () => ({ default: () => <p>Not found</p> }));

import MembershipInvoiceHistoryPage from "./membership-invoice-history";
function page() {
  return renderToStaticMarkup(<Router hook={() => ["/membership/invoice-history", () => {}]}><MembershipInvoiceHistoryPage /></Router>);
}
beforeEach(() => {
  state.role = "owner";
  state.userId = "owner-a";
  state.loaded = true;
  state.error = false;
  state.pending = false;
  state.data = { memberships: [{
    checkoutId: 42, memberId: "private-member", subscriptionId: "sub_private",
    retryAttempts: 4, nextRetryAt: "2026-10-03T12:00:00Z",
  }], nextCursor: null };
  state.query.mockClear();
});
test.each(["member", "editor", "unknown"])("never queries or renders private records for %s", role => {
  state.role = role;
  expect(page()).toContain("Not found");
  expect(page()).not.toContain("private-member");
  expect(state.query).not.toHaveBeenCalled();
});
test("does not request private data before identity is loaded or when signed out", () => {
  state.loaded = false;
  expect(page()).toBe("");
  state.loaded = true;
  state.userId = "";
  expect(page()).toContain("Not found");
  expect(state.query).not.toHaveBeenCalled();
});
test.each(["owner", "admin"])("%s sees persisted retry state and ended-access explanation", role => {
  state.role = role;
  const html = page();
  expect(html).toContain("private-member");
  expect(html).toContain("sub_private");
  expect(html).toContain("Failed attempts");
  expect(html).toContain(">4<");
  expect(html).toContain("Access remains ended");
  expect(html).toContain("Missing history is not proof of payment failure");
  expect(state.query).toHaveBeenCalledWith(undefined, {
    query: expect.objectContaining({
      queryKey: ["pending-history", "owner-a"], gcTime: 0, refetchInterval: 60000,
      refetchOnMount: "always", refetchOnWindowFocus: "always",
    }),
  });
});
test("separates private cache keys between staff accounts", () => {
  page();
  state.userId = "admin-b";
  page();
  expect(state.query.mock.calls[1][1].query.queryKey).toEqual(["pending-history", "admin-b"]);
});
test("hides previously loaded records when a refresh fails", () => {
  state.error = true;
  const html = page();
  expect(html).toContain("Invoice history could not be loaded");
  expect(html).toContain("Try again");
  expect(html).not.toContain("private-member");
});
test("shows loading and empty states distinctly", () => {
  state.pending = true;
  expect(page()).toContain('data-testid="state-loading"');
  state.pending = false;
  state.data.memberships = [];
  expect(page()).toContain("Nothing awaiting invoice history");
});
test("missing schedule is not labeled recovered", () => {
  state.data.memberships[0].nextRetryAt = null;
  expect(page()).toContain("No retry time recorded");
});
test("offers another page when the server provides a cursor", () => {
  state.data.nextCursor = 42;
  expect(page()).toContain('data-testid="button-next"');
});