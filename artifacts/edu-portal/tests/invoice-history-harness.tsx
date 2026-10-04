import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetPendingMembershipInvoiceHistoryQueryKey, setAuthTokenGetter } from "@workspace/api-client-react";
import MembershipInvoiceHistoryPage from "../src/pages/membership-invoice-history";

// The isolated Vite config supplies a signed-in Clerk stand-in. Keep the real
// page, layout, generated HTTP client, and React Query freshness behavior.
setAuthTokenGetter(async () => window.localStorage.getItem("audit-test-account"));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const { hook } = memoryLocation({ path: "/membership/invoice-history" });

function HistoryHarness() {
  const fetching = useIsFetching({ queryKey: getGetPendingMembershipInvoiceHistoryQueryKey() });
  return <>
    <output data-testid="history-fetching">{fetching}</output>
    <MembershipInvoiceHistoryPage />
  </>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}><HistoryHarness /></Router>
  </QueryClientProvider>,
);