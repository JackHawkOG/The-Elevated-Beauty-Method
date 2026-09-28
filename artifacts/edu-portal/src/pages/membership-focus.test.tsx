// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("@clerk/react", () => ({ useUser: () => ({ user: { publicMetadata: { role: "member" } } }) }));
vi.mock("@/components/layout", () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMembershipOffer: () => ({ data: { phase: "open", foundingAvailable: true }, isLoading: false, isError: false }),
    useGetConfirmedMembershipCounts: () => ({}),
    useGetMembershipCheckoutCleanupAlerts: () => ({}),
    useCreateMembershipCheckout: () => ({ isPending: false }),
    useCreateMembershipPortal: () => ({ isPending: false }),
  };
});

import MembershipPage from "./membership";

afterEach(() => vi.unstubAllGlobals());

test("window focus refetches membership and updates cancellation, resumed, and ended wording in place", async () => {
  const cancellationDate = "2030-06-15T12:00:00.000Z";
  let latest = { kind: "founding", status: "confirmed", cancellationDate: cancellationDate as string | null };
  const requests = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/membership/me");
    return new Response(JSON.stringify({ membership: latest }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/membership");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  async function expectWording(text: string) {
    for (let attempt = 0; attempt < 50 && !container.textContent?.includes(text); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(container.textContent).toContain(text);
  }

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Router hook={() => ["/membership", () => {}]}>
            <MembershipPage />
          </Router>
        </QueryClientProvider>,
      );
    });
    await expectWording("membership is active until your scheduled cancellation.");
    expect(container.textContent).toContain("Your cancellation takes effect on");
    expect(requests).toHaveBeenCalledTimes(1);

    latest = { kind: "founding", status: "confirmed", cancellationDate: null };
    expect(container.textContent).toContain("scheduled cancellation");
    await act(async () => { window.dispatchEvent(new Event("visibilitychange")); });
    await expectWording("membership is active.");
    expect(requests).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Your cancellation takes effect on");

    latest = { kind: "founding", status: "forfeited", cancellationDate: null };
    await act(async () => { window.dispatchEvent(new Event("visibilitychange")); });
    await expectWording("membership has ended.");
    expect(requests).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("membership is active");
    expect(container.textContent).not.toContain("Your cancellation takes effect on");
    expect(window.location.pathname).toBe("/membership");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});