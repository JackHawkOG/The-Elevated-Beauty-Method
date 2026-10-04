import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";

const state = vi.hoisted(() => ({
  userId: "staff-fixture" as string | undefined,
  role: "owner",
  data: { overdueCount: 2, failedAttemptThreshold: 8 },
  isError: false,
  query: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: state.userId ? { id: state.userId, publicMetadata: { role: state.role } } : null }),
}));
vi.mock("@workspace/api-client-react", () => ({
  getGetMembershipInvoiceHistoryNoticeQueryKey: () => ["/membership/invoice-history-notice"],
  useGetMembershipInvoiceHistoryNotice: (options: unknown) => {
    state.query(options);
    return { data: state.data, isError: state.isError };
  },
}));
import { InvoiceHistoryNotice } from "./invoice-history-notice";

function render() {
  return renderToStaticMarkup(<Router hook={() => ["/dashboard", () => {}]}><InvoiceHistoryNotice /></Router>);
}
beforeEach(() => {
  state.userId = "staff-fixture";
  state.role = "owner";
  state.data = { overdueCount: 2, failedAttemptThreshold: 8 };
  state.isError = false;
  state.query.mockClear();
});
test.each(["owner", "admin"])("%s sees a generic operational notice and private link", role => {
  state.role = role;
  const html = render();
  expect(html).toContain("Invoice history recovery needs attention");
  expect(html).toContain("at least 8 times");
  expect(html).toContain('href="/membership/invoice-history"');
  expect(html).toContain("not proof of payment failure");
  expect(html).toContain("Access remains ended");
  expect(html).not.toContain(state.userId);
  expect(html).not.toContain("2 ended");
  expect(state.query).toHaveBeenCalledWith({ query: {
    queryKey: ["/membership/invoice-history-notice", "staff-fixture"],
    enabled: true, gcTime: 0, staleTime: 0, retry: false,
    refetchInterval: 30_000, refetchOnMount: "always", refetchOnWindowFocus: "always",
  } });
});
test("successful recovery clears the notice", () => {
  expect(render()).toContain("needs attention");
  state.data.overdueCount = 0;
  expect(render()).toBe("");
});
test.each(["member", "editor", "unknown"])("%s cannot request or see cached staff notices", role => {
  state.role = role;
  expect(render()).toBe("");
  expect(state.query.mock.calls[0][0].query.enabled).toBe(false);
});
test("sign-out hides cached notices and account changes scope the query", () => {
  state.userId = undefined;
  expect(render()).toBe("");
  expect(state.query.mock.calls[0][0].query.enabled).toBe(false);
  state.userId = "other-staff";
  render();
  expect(state.query.mock.lastCall![0].query.queryKey).toEqual(["/membership/invoice-history-notice", "other-staff"]);
});
test.each([0, 2])("an outage replaces stale count %s with explicit uncertainty", count => {
  state.data.overdueCount = count;
  state.isError = true;
  const html = render();
  expect(html).toContain("could not be checked");
  expect(html).toContain("No recovery status can be confirmed");
  expect(html).not.toContain("needs attention");
  expect(html).toContain('href="/membership/invoice-history"');
  state.isError = false;
  state.data.overdueCount = 0;
  expect(render()).toBe("");
});