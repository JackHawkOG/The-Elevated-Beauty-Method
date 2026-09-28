import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetLessonQueryKey, getListLessonsQueryKey } from "@workspace/api-client-react";
import LessonPage from "../src/pages/lesson";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const { hook } = memoryLocation({ path: "/courses/7/lessons/42" });

// Simulate background refetches while keeping the loaded lesson and query cache intact.
document.getElementById("root")!.innerHTML = '<button id="refetch-lesson" type="button">Refresh lesson</button><button id="refetch-outline" type="button">Refresh outline</button><div id="page"></div>';
document.getElementById("refetch-lesson")!.addEventListener("click", () => {
  void client.invalidateQueries({ queryKey: getGetLessonQueryKey(42) });
});
document.getElementById("refetch-outline")!.addEventListener("click", () => {
  void client.invalidateQueries({ queryKey: getListLessonsQueryKey(7) });
});

function LessonWithLocation() {
  const [location] = useLocation();
  return (
    <>
      <output data-testid="current-location">{location}</output>
      <LessonPage />
    </>
  );
}

createRoot(document.getElementById("page")!).render(
  <QueryClientProvider client={client}>
    <Router hook={hook}>
      <LessonWithLocation />
    </Router>
  </QueryClientProvider>,
);