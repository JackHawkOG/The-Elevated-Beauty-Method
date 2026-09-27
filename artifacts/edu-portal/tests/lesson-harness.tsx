import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetLessonQueryKey } from "@workspace/api-client-react";
import LessonPage from "../src/pages/lesson";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const { hook } = memoryLocation({ path: "/courses/7/lessons/42" });

// Simulate a background refetch without navigating away from the previously loaded lesson.
document.getElementById("root")!.innerHTML = '<button id="refetch-lesson" type="button">Refresh lesson</button><div id="page"></div>';
document.getElementById("refetch-lesson")!.addEventListener("click", () => {
  void client.invalidateQueries({ queryKey: getGetLessonQueryKey(42) });
});

createRoot(document.getElementById("page")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}>
      <LessonPage />
    </Router>
  </QueryClientProvider>,
);