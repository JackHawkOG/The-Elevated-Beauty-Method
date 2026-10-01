import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, Route, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import RadiantAuditPage, { RadiantAuditCompletePage } from "../src/pages/radiant-audit";
import Dashboard from "../src/pages/dashboard";
import { pruneInvalidAuditDraft } from "../src/lib/radiant-audit-draft";

setAuthTokenGetter(async () =>
  window.sessionStorage.getItem("audit-test-tab-account") ?? window.localStorage.getItem("audit-test-account"));
import { getGetRadiantAuditHistoryQueryKey, setAuthTokenGetter } from "@workspace/api-client-react";
import { AppLayout } from "../src/components/layout";
const params = new URLSearchParams(location.search);
const { hook, navigate } = memoryLocation({ path: params.get("page") || "/radiant-audit" });
// Opt-in seam: keep the real form mounted after a confirmed save so tests can
// exercise its change effect before routing unmounts it.
const navigation = { pending: null as string | null, release: () => {
  if (navigation.pending) navigate(navigation.pending);
} };
(window as unknown as { __auditNavigation: typeof navigation }).__auditNavigation = navigation;
const transitionHook: typeof hook = () => {
  const [path, setPath] = hook();
  return [path, (next, options) => {
    if (params.has("holdSaveNavigation") && next === "/radiant-audit/complete") {
      navigation.pending = next;
      return;
    }
    setPath(next, options);
  }];
};
// Match the app's startup cleanup while exercising non-Audit routes in isolation.
pruneInvalidAuditDraft();

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
(window as unknown as { __refreshAuditHistory: () => Promise<void> }).__refreshAuditHistory =
  async () => { await client.invalidateQueries({ queryKey: getGetRadiantAuditHistoryQueryKey() }); };

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Router hook={transitionHook}>
      <Switch>
        <Route path="/layout"><AppLayout><p>Member area</p></AppLayout></Route>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/radiant-audit/complete" component={RadiantAuditCompletePage} />
        <Route path="/radiant-audit" component={RadiantAuditPage} />
      </Switch>
    </Router>
  </QueryClientProvider>,
);
