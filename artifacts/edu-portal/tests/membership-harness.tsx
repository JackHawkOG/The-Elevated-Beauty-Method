import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import MembershipPage from "../src/pages/membership";

setAuthTokenGetter(async () => window.localStorage.getItem("audit-test-account"));
const { hook } = memoryLocation({ path: "/membership" });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Router hook={hook}>
      <MembershipPage />
    </Router>
  </QueryClientProvider>,
);