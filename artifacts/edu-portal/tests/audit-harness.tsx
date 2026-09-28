import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import RadiantAuditPage, { RadiantAuditCompletePage } from "../src/pages/radiant-audit";
import Dashboard from "../src/pages/dashboard";
import { pruneInvalidAuditDraft } from "../src/lib/radiant-audit-draft";

setAuthTokenGetter(async () => window.localStorage.getItem("audit-test-account"));
import { getGetRadiantAuditHistoryQueryKey, setAuthTokenGetter } from "@workspace/api-client-react";
const { hook } = memoryLocation({ path: new URLSearchParams(location.search).get("page") || "/radiant-audit" });
// Match the app's startup cleanup while exercising non-Audit routes in isolation.
pruneInvalidAuditDraft();

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
(window as unknown as { __refreshAuditHistory: () => Promise<void> }).__refreshAuditHistory =
  async () => { await client.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() }); };

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/radiant-audit/complete" component={RadiantAuditCompletePage} />
        <Route path="/radiant-audit" component={RadiantAuditPage} />
      </Switch>
    </Router>
  </QueryClientProvider>,
);
