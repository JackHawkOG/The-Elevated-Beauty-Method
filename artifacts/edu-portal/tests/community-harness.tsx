import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import CommunityPage from "../src/pages/community";
import { Toaster } from "../src/components/ui/toaster";
import "../src/index.css";

// Exercise the real page, cards and generated API client without live member data.
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const { hook } = memoryLocation({ path: "/community" });

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}>
      <CommunityPage />
      <Toaster />
    </Router>
  </QueryClientProvider>,
);