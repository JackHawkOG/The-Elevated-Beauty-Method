// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Router } from "wouter";
import type { RoutineGuideClaimResult } from "@workspace/api-client-react";
import { trackGuideFailure, trackGuideResult } from "@/lib/guide-analytics";

const state = vi.hoisted(() => ({
  pending: false, loadError: false, available: true,
  result: undefined as RoutineGuideClaimResult | undefined,
  mutationPending: false,
  options: {} as { onSuccess: (data: RoutineGuideClaimResult) => void; onError: (error: unknown) => void },
  mutate: vi.fn(),
}));
vi.mock("@workspace/api-client-react", () => ({
  claimMembershipConversion: vi.fn(),
  useGetRoutineGuide: () => ({
    isPending: state.pending, isError: state.loadError, refetch: vi.fn(),
    data: { available: state.available, privacyNotice: "Guide-only records.", consentText: "Email me this guide." },
  }),
  getGetRoutineGuideQueryKey: () => ["/routine-guide"],
  useClaimRoutineGuide: ({ mutation }: { mutation: typeof state.options }) => {
    state.options = mutation;
    return { data: state.result, isError: false, isPending: state.mutationPending, mutate: state.mutate };
  },
}));
import ElevatedRoutinePage from "./elevated-routine";

let root: Root;
let container: HTMLDivElement;
const track = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.umami = { track };
  track.mockClear();
  state.mutate.mockReset();
  state.pending = false;
  state.loadError = false;
  state.available = true;
  state.result = undefined;
  state.mutationPending = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.umami;
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<StrictMode><Router hook={() => ["/the-elevated-routine", () => {}]}><ElevatedRoutinePage /></Router></StrictMode>));
}
async function fill() {
  const email = container.querySelector<HTMLInputElement>("#guide-email")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(email, "private-person@example.com");
    email.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLInputElement>("#guide-consent")!.click();
  });
}
async function submit() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("form view counts once under StrictMode and refetch, never during loading/unavailability", async () => {
  state.pending = true;
  await render();
  expect(track).not.toHaveBeenCalled();
  state.pending = false;
  state.available = false;
  await render();
  expect(track).not.toHaveBeenCalled();
  state.available = true;
  state.loadError = true;
  await render();
  expect(track).not.toHaveBeenCalled();
  state.loadError = false;
  await render();
  await render();
  expect(track.mock.calls).toEqual([["guide_form_viewed", undefined]]);
  expect(state.mutate).not.toHaveBeenCalled();
});

test("invalid form does not submit; a valid retry preserves the request and counts only fixed data", async () => {
  await render();
  await submit();
  expect(state.mutate).not.toHaveBeenCalled();
  await fill();
  await submit();
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenLastCalledWith("guide_request_submitted", { attempt: "initial" });
  const first = state.mutate.mock.calls[0];
  expect(first[0].data).toMatchObject({ email: "private-person@example.com", consent: true, website: "" });
  await submit();
  expect(state.mutate).toHaveBeenCalledTimes(1);
  state.options.onError({ status: 503, message: "private error", data: { email: "private-person@example.com" } });
  first[1].onSettled();
  await submit();
  expect(state.mutate).toHaveBeenCalledTimes(2);
  expect(state.mutate.mock.calls[1][0]).toEqual(first[0]);
  state.options.onSuccess({ status: "sent", outcome: "deduplicated", message: "private provider message" });
  expect(track.mock.calls).toEqual([
    ["guide_form_viewed", undefined],
    ["guide_request_submitted", { attempt: "initial" }],
    ["guide_request_failed", { reason: "unavailable_or_uncertain" }],
    ["guide_request_submitted", { attempt: "retry" }],
    ["guide_request_deduplicated", undefined],
  ]);
});

test("processing does not poll or send automatically; explicit check is distinct", async () => {
  await render();
  await fill();
  await submit();
  state.result = { status: "processing", outcome: "processing", message: "Still processing." };
  state.options.onSuccess(state.result);
  state.mutate.mock.calls[0][1].onSettled();
  await render();
  await render();
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(track.mock.calls.filter(call => call[0] === "guide_request_processing")).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="button-retry-processing"]')!.click());
  expect(state.mutate).toHaveBeenCalledTimes(2);
  expect(state.mutate.mock.calls[1][0]).toEqual(state.mutate.mock.calls[0][0]);
  expect(track).toHaveBeenLastCalledWith("guide_request_submitted", { attempt: "check" });
});

test("outcomes and failures expose only fixed categories, never mailbox delivery or raw server data", () => {
  trackGuideResult({ status: "sent", outcome: "accepted" });
  trackGuideResult({ status: "sent", outcome: "deduplicated" });
  trackGuideResult({ status: "processing", outcome: "processing" });
  trackGuideResult({ status: "sent" });
  for (const status of [400, 409, 429, 503, 500, undefined]) {
    trackGuideFailure({ status, email: "private-person@example.com", requestId: "private-id", message: "free text" });
  }
  expect(track.mock.calls).toEqual([
    ["guide_request_accepted", undefined],
    ["guide_request_deduplicated", undefined],
    ["guide_request_processing", undefined],
    ["guide_request_outcome_unknown", undefined],
    ...["invalid_request", "conflict", "rate_limited", "unavailable_or_uncertain", "unknown", "unknown"]
      .map(reason => ["guide_request_failed", { reason }]),
  ]);
});

test.each(["absent", "throws", "rejects"])("a tracker that %s cannot block or repeat a guide request", async mode => {
  if (mode === "absent") delete window.umami;
  else window.umami = { track: () => {
    if (mode === "throws") throw new Error("blocked");
    return Promise.reject(new Error("blocked"));
  } };
  await render();
  await fill();
  await submit();
  state.options.onSuccess({ status: "sent", outcome: "accepted", message: "Accepted." });
  await act(async () => { await Promise.resolve(); });
  expect(state.mutate).toHaveBeenCalledTimes(1);
});