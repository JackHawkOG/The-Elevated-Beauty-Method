// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getListEnrollmentsQueryKey, type Enrollment } from "@workspace/api-client-react";
import CoursesPage from "./courses";
import CourseDetailPage from "./course-detail";

const { toast, course } = vi.hoisted(() => ({
  toast: vi.fn(),
  course: {
    id: 42, title: "Test pathway", description: "A course", accessTier: "Free",
    categoryName: "Test", difficulty: "Beginner", enrollmentCount: 0,
    instructorName: "Instructor", lessonCount: 1, createdAt: "2026-10-02T00:00:00Z",
    lessons: [{ id: 7, title: "First lesson", durationMinutes: 5 }],
  },
}));
vi.mock("@/components/layout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/api-client-react")>(),
  useListCourses: () => ({ data: [course], isLoading: false }),
  useListCategories: () => ({ data: [], isLoading: false }),
  useGetCourse: () => ({ data: course, isLoading: false }),
}));

const enrollment: Enrollment = {
  id: 12, userId: "test-member", courseId: 42, courseTitle: "Test pathway", completedLessons: 0,
  totalLessons: 1, enrolledAt: "2026-10-02T00:00:00Z",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  expect(until()).toBe(true);
}

for (const page of ["list", "detail"] as const) {
  for (const failure of ["success", "network", "server", "timeout", "invalid reply", "missing", "lookup unavailable", "access", "validation"] as const) {
    test(`${page}: ${failure} enrollment reply has accurate status`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      let persisted: Enrollment[] = [];
      let posts = 0;
      let recoveryReads = 0;
      let finishLookup: (() => void) | undefined;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts++;
          if (failure === "access" || failure === "validation") {
            return Response.json({ error: failure === "access" ? "Premium membership required" : "Invalid course ID" },
              { status: failure === "access" ? 403 : 400 });
          }
          persisted = failure === "missing" ? [] : [enrollment];
          if (failure === "success") return Response.json(enrollment, { status: 201 });
          if (failure === "server") return Response.json({ error: "Server error" }, { status: 500 });
          if (failure === "timeout") return Response.json({ error: "Request timed out" }, { status: 408 });
          if (failure === "invalid reply") return new Response("{", { headers: { "content-type": "application/json" } });
          throw new TypeError("Failed to fetch");
        }
        if (posts > 0) {
          recoveryReads++;
          // Hold the first recovery read to verify no premature failure or retry.
          if (recoveryReads === 1 && failure !== "success") {
            await new Promise<void>(resolve => { finishLookup = resolve; });
            if (failure === "lookup unavailable") throw new TypeError("Offline");
          }
        }
        return Response.json(persisted);
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      // Even a fresh-but-stale cache must not satisfy the recovery check.
      client.setQueryData(getListEnrollmentsQueryKey(), []);
      const location = memoryLocation({ path: page === "list" ? "/courses" : "/courses/42", record: true });
      const container = document.createElement("div");
      const mountedRoot = createRoot(container);
      try {
        await act(async () => mountedRoot.render(
          <QueryClientProvider client={client}>
            <Router hook={location.hook}>
              {page === "list" ? <CoursesPage /> : <CourseDetailPage />}
            </Router>
          </QueryClientProvider>,
        ));
        await settle(() => Array.from(container.querySelectorAll("button")).some(button =>
          button.textContent?.includes(page === "list" ? "Access" : "Enroll Now")));
        const button = Array.from(container.querySelectorAll("button")).find(button =>
          button.textContent?.includes(page === "list" ? "Access" : "Enroll Now"))!;
        await act(async () => button.click());
        const definitive = failure === "access" || failure === "validation";
        if (!definitive && failure !== "success") {
          await settle(() => !!finishLookup);
          expect(toast).not.toHaveBeenCalled();
          await settle(() => button.disabled);
          expect(posts).toBe(1);
          await act(async () => finishLookup!());
        }
        await settle(() => toast.mock.calls.length > 0);
        expect(posts).toBe(1);
        const notice = toast.mock.calls[0][0];
        if (failure === "success" || failure === "network" || failure === "server" || failure === "timeout" || failure === "invalid reply") {
          expect(notice.title).toBe("Enrolled successfully");
          expect(client.getQueryData<Enrollment[]>(getListEnrollmentsQueryKey())).toEqual([enrollment]);
          if (page === "list") expect(location.history?.at(-1)).toBe("/courses/42");
          else await settle(() => container.textContent?.includes("Start Course") === true);
        } else {
          expect(notice.variant).toBe("destructive");
          expect(notice.title).toBe(failure === "access" ? "Membership upgrade required"
            : failure === "lookup unavailable" ? "Enrollment not confirmed" : "Enrollment failed");
          expect(notice.description).toContain(failure === "access" ? "Premium membership required"
            : failure === "validation" ? "Invalid course ID"
            : failure === "missing" ? "wasn't found" : "couldn't confirm");
          expect(container.textContent).not.toContain("Start Course");
          if (definitive) expect(recoveryReads).toBe(0);
          if (page === "list") expect(location.history?.at(-1)).toBe("/courses");
        }
      } finally {
        await act(async () => mountedRoot.unmount());
        client.clear();
      }
    });
  }
}