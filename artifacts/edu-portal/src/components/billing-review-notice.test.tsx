import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";

const state = vi.hoisted(() => ({
  userId: "owner-fixture" as string | undefined,
  role: "owner",
  data: [{ id: "opaque-notice", createdAt: "2026-10-01T14:00:00Z" }],
  isError: false,
  query: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: state.userId ? { id: state.userId, publicMetadata: { role: state.role } } : null }),
}));
vi.mock("@workspace/api-client-react", () => ({
  getGetMembershipReviewNotificationsQueryKey: () => ["/membership/review-notifications"],
  useGetMembershipReviewNotifications: (options: unknown) => {
    state.query(options);
    return { data: state.data, isError: state.isError };
  },
}));
import { BillingReviewNotice } from "./billing-review-notice";

function render() {
  return renderToStaticMarkup(<Router hook={() => ["/dashboard", () => {}]}><BillingReviewNotice /></Router>);
}
beforeEach(() => {
  state.userId = "owner-fixture";
  state.role = "owner";
  state.data = [{ id: "opaque-notice", createdAt: "2026-10-01T14:00:00Z" }];
  state.isError = false;
  state.query.mockClear();
});

test("an owner sees a private notice on the dashboard, without notification or payment metadata", () => {
  const html = render();
  expect(html).toContain("Billing review needs attention");
  expect(html).toContain("one founding subscription has");
  expect(html).toContain('href="/membership"');
  expect(html).not.toContain("opaque-notice");
  expect(html).not.toContain("2026-10-01");
  expect(state.query).toHaveBeenCalledWith({ query: {
    queryKey: ["/membership/review-notifications", "owner-fixture"],
    enabled: true, staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: "always",
  } });
  expect(render()).toBe(html); // Refetching the same notice does not add another banner.
  state.data = [];
  expect(render()).toBe(""); // Recovery removes the banner.
});

test.each(["member", "editor", "unknown"])("%s cannot request or see cached owner notifications", role => {
  state.role = role;
  expect(render()).toBe("");
  expect(state.query.mock.calls[0][0].query.enabled).toBe(false);
});

test("signing out hides an old owner's cache and disables requests", () => {
  state.userId = undefined;
  expect(render()).toBe("");
  expect(state.query.mock.calls[0][0].query.enabled).toBe(false);
});

test("a failed refresh reports unavailable status instead of showing stale outage counts", () => {
  state.isError = true;
  expect(render()).toContain("could not be checked");
  expect(render()).not.toContain("one founding subscription");
});