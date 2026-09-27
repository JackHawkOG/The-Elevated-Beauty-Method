import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import RadiantAuditPage, { RadiantAuditCompletePage } from "../src/pages/radiant-audit";

setAuthTokenGetter(async () => window.localStorage.getItem("audit-test-account"));
const { hook } = memoryLocation({ path: new URLSearchParams(location.search).get("page") || "/radiant-audit" });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Router hook={hook}>
      <Switch>
        <Route path="/radiant-audit/complete" component={RadiantAuditCompletePage} />
        <Route path="/radiant-audit" component={RadiantAuditPage} />
      </Switch>
    </Router>
  </QueryClientProvider>,
);