import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetMembershipReviewNotificationsQueryKey, setAuthTokenGetter } from "@workspace/api-client-react";
import Dashboard from "../src/pages/dashboard";

// Only the isolated Vite server aliases Clerk. Real dashboard/layout/query hooks
// remain mounted throughout refreshes and identity changes; no live auth or billing.
setAuthTokenGetter(async () => window.localStorage.getItem("audit-test-account"));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const { hook } = memoryLocation({ path: "/dashboard" });

function DashboardHarness() {
  const [location] = useLocation();
  const fetching = useIsFetching({ queryKey: getGetMembershipReviewNotificationsQueryKey() });
  return <>
    <output data-testid="current-location">{location}</output>
    <output data-testid="billing-fetching">{fetching}</output>
    <button onClick={() => {
      window.localStorage.setItem("audit-test-account", "billing-notice-member");
      window.dispatchEvent(new Event("audit-test-auth-change"));
    }}>Switch to member</button>
    <button onClick={() => {
      // Prove switching hid a genuinely retained owner cache, not an empty one.
      const cached = client.getQueryData<unknown[]>([
        ...getGetMembershipReviewNotificationsQueryKey(), "billing-notice-owner",
      ]);
      document.getElementById("owner-cache")!.textContent = String(cached?.length ?? 0);
    }}>Inspect owner cache</button>
    <output id="owner-cache" data-testid="owner-cache" />
    <Dashboard />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}><DashboardHarness /></Router>
  </QueryClientProvider>,
);