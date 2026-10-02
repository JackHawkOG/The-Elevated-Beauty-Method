import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  role: "owner", enabled: false, available: true, error: false, pending: false,
  query: vi.fn(), mutation: vi.fn(), setQueryData: vi.fn(), invalidateQueries: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useUser: () => ({ user: { id: "owner-fixture", publicMetadata: { role: state.role } } }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData: state.setQueryData, invalidateQueries: state.invalidateQueries }) }));
vi.mock("@workspace/api-client-react", () => ({
  getGetMembershipReviewEmailPreferenceQueryKey: () => ["preference"],
  useGetMembershipReviewEmailPreference: (options: unknown) => {
    state.query(options);
    return { data: { enabled: state.enabled, available: state.available }, isError: state.error, isPending: state.pending };
  },
  useUpdateMembershipReviewEmailPreference: () => ({ mutate: state.mutation, isPending: false, isError: false }),
}));
import { MembershipReviewEmailPreference } from "./membership-review-email-preference";
beforeEach(() => { state.role = "owner"; state.enabled = false; state.available = true; state.error = false; state.pending = false; vi.clearAllMocks(); });
test("only the owner sees email preferences; owner-scoped state stays fresh", () => {
  const html = renderToStaticMarkup(<MembershipReviewEmailPreference />);
  expect(html).toContain("Enable outage emails");
  expect(html).toContain("never member identities or payment details");
  expect(state.query).toHaveBeenCalledWith({ query: expect.objectContaining({ queryKey: ["preference", "owner-fixture"], enabled: true, gcTime: 0, refetchInterval: 60000 }) });
  for (const role of ["member", "admin"]) {
    state.role = role;
    expect(renderToStaticMarkup(<MembershipReviewEmailPreference />)).toBe("");
  }
});
test("on/off and unavailable/error/loading states are explicit", () => {
  state.enabled = true;
  expect(renderToStaticMarkup(<MembershipReviewEmailPreference />)).toContain("Turn off outage emails");
  state.enabled = false; state.available = false;
  expect(renderToStaticMarkup(<MembershipReviewEmailPreference />)).toContain("configured published review link");
  state.error = true;
  expect(renderToStaticMarkup(<MembershipReviewEmailPreference />)).toContain("could not be checked");
  state.error = false; state.pending = true;
  expect(renderToStaticMarkup(<MembershipReviewEmailPreference />)).toContain("Checking email preferences");
});
test("the button submits the real boolean contract and updates the current account cache", () => {
  const component = MembershipReviewEmailPreference();
  const children = component!.props.children;
  const ready = children[2];
  const button = ready.props.children[2];
  button.props.onClick();
  expect(state.mutation).toHaveBeenCalledWith({ data: { enabled: true } }, expect.anything());
  const options = state.mutation.mock.calls[0]![1];
  options.onSuccess({ enabled: true, available: true });
  expect(state.setQueryData).toHaveBeenCalledWith(["preference", "owner-fixture"], { enabled: true, available: true });
  expect(state.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["preference"] });
});