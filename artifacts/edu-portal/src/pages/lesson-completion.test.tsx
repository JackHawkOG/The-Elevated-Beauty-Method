// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getListLessonsQueryKey } from "@workspace/api-client-react";

const state = vi.hoisted(() => ({
  lessonId: "1", navigate: vi.fn(), toast: vi.fn(),
}));
vi.mock("wouter", () => ({
  useRoute: () => [true, { courseId: "10", lessonId: state.lessonId }],
  useLocation: () => ["/lesson", state.navigate],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@workspace/api-client-react", async importOriginal => ({
  ...await importOriginal<typeof import("@workspace/api-client-react")>(),
  useGetCourse: () => ({ data: { title: "Course" } }),
  useGetLesson: () => ({ data: { id: Number(state.lessonId), title: "Lesson", content: "Read this." } }),
  useListLessons: () => ({ data: [{ id: 1, title: "First" }, { id: 2, title: "Next" }] }),
  useListEnrollments: () => ({ data: [] }),
}));
import LessonPage from "./lesson";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.lessonId = "1";
});

test.each([
  ["departed member", 200],
  ["departed member", 500],
  ["different lesson", 200],
  ["different lesson", 500],
  ["active lesson", 200],
  ["active lesson", 500],
] as const)("late completion response: %s, HTTP %s", async (destination, status) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: (response: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(getListLessonsQueryKey(10), [{ id: 1 }, { id: 2 }]);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () => root.render(<QueryClientProvider client={client}><LessonPage /></QueryClientProvider>);
  let unmounted = false;
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 50 && !until(); i++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(until()).toBe(true);
  };
  try {
    await act(async () => render());
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Complete & Continue")!.click();
    });
    await settle(() => fetchMock.mock.calls.length === 1);
    const mutation = client.getMutationCache().getAll()[0];
    if (destination === "departed member") {
      await act(async () => root.unmount());
      unmounted = true;
    } else if (destination === "different lesson") {
      state.lessonId = "2";
      await act(async () => render());
    }
    await act(async () => release(new Response(JSON.stringify(status === 200 ? {} : { error: "Unavailable" }), {
      status, headers: { "content-type": "application/json" },
    })));
    // Wait for the real mutation lifecycle, including the page's callbacks.
    await settle(() => mutation.state.status === (status === 200 ? "success" : "error"));
    if (destination !== "active lesson") {
      expect(state.toast).not.toHaveBeenCalled();
      expect(state.navigate).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      if (destination === "different lesson") expect(container.textContent).not.toContain("Completed · Continue");
    } else if (status === 200) {
      expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Progress saved" }));
      expect(state.navigate).toHaveBeenCalledWith("/courses/10/lessons/2");
      expect(invalidate).toHaveBeenCalledOnce();
    } else {
      expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error", variant: "destructive" }));
      expect(state.navigate).not.toHaveBeenCalled();
    }
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});