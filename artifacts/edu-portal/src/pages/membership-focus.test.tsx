// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { getGetMyMembershipQueryKey } from "@workspace/api-client-react";

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

test("history restore hides cached cancellation and access details when membership refresh fails in place", async () => {
  const cached = {
    membership: { kind: "founding", status: "confirmed", cancellationDate: "2030-06-15T12:00:00.000Z" },
  };
  let refreshFails = false;
  const requests = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/membership/me");
    return new Response(JSON.stringify(refreshFails ? { error: "Billing unavailable" } : cached), {
      status: refreshFails ? 503 : 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/membership");
  const navigate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Match the member fixture's user-scoped key, including its absent mock user ID.
  const queryKey = [...getGetMyMembershipQueryKey(), undefined];
  client.setQueryData(queryKey, cached);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Router hook={() => ["/membership", navigate]}>
            <MembershipPage />
          </Router>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle");
      expect(requests).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("membership is active until your scheduled cancellation.");
      expect(container.textContent).toContain("Your cancellation takes effect on");
      expect(container.textContent).toContain("You keep access until then.");
    });

    refreshFails = true;
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Your membership status could not be checked. Please try again later.",
      );
    });
    expect(requests).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(queryKey)?.status).toBe("error");
    // React Query retains old data on a failed refetch; the UI must not trust it.
    expect(client.getQueryData(queryKey)).toEqual(cached);
    expect(container.textContent).not.toContain("scheduled cancellation");
    expect(container.textContent).not.toContain("Your cancellation takes effect on");
    expect(container.textContent).not.toContain("June 15");
    expect(container.textContent).not.toContain("membership is active");
    expect(container.textContent).not.toContain("You keep access until then.");
    expect(container.textContent).not.toContain("Manage billing or cancel");
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/membership");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test.each([
  { trigger: "window focus", event: "visibilitychange" },
  { trigger: "history restore", event: "pageshow" },
])("$trigger refetches membership and updates cancellation, resumed, and ended wording in place", async ({ event }) => {
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
    await act(async () => {
      window.dispatchEvent(event === "pageshow"
        ? new PageTransitionEvent("pageshow", { persisted: true })
        : new Event("visibilitychange"));
    });
    await expectWording("membership is active.");
    expect(requests).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("scheduled cancellation");
    expect(container.textContent).not.toContain("Your cancellation takes effect on");

    latest = { kind: "founding", status: "forfeited", cancellationDate: null };
    await act(async () => {
      window.dispatchEvent(event === "pageshow"
        ? new PageTransitionEvent("pageshow", { persisted: true })
        : new Event("visibilitychange"));
    });
    await expectWording("membership has ended.");
    expect(requests).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("membership is active");
    expect(container.textContent).not.toContain("scheduled cancellation");
    expect(container.textContent).not.toContain("Your cancellation takes effect on");
    expect(window.location.pathname).toBe("/membership");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});