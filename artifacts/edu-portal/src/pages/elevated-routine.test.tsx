import { beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  info: {
    title: "The Elevated Routine",
    consentText: "Email me The Elevated Routine from The Elevated Beauty Method ™.",
    privacyNotice: "Guide delivery and consent records only. Resend processes the email. No marketing.",
    pageCount: 9, version: "1", available: true, publishedInLibrary: false,
  },
  loading: false,
  unavailable: false,
  loadError: false,
  claim: {
    data: undefined as undefined | { status: "sent" | "processing"; message: string },
    isPending: false, isError: false,
    error: null as null | { status: number },
  },
  guides: [] as Array<{ title: string; version: string; pageCount: number }>,
  mutate: vi.fn(),
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetRoutineGuide: () => ({
    data: { ...state.info, available: !state.unavailable },
    isPending: state.loading, isError: state.loadError, refetch: vi.fn(),
  }),
  getGetRoutineGuideQueryKey: () => ["/routine-guide"],
  useClaimRoutineGuide: () => ({ ...state.claim, mutate: state.mutate }),
  useListDigitalGuides: () => ({ data: state.guides, isPending: false, isError: false }),
  getListDigitalGuidesQueryKey: () => ["/digital-guides"],
}));
vi.mock("@/components/layout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import ElevatedRoutinePage from "./elevated-routine";
import GuidePrivacyPage from "./guide-privacy";
import GuidesPage from "./guides";

function render(node: ReactNode) {
  return renderToStaticMarkup(<Router hook={() => ["/the-elevated-routine", () => {}]}>{node}</Router>);
}
beforeEach(() => {
  state.loading = false;
  state.loadError = false;
  state.unavailable = false;
  state.claim = { data: undefined, isPending: false, isError: false, error: null };
  state.guides = [];
  state.mutate.mockClear();
});
test("public form requires separate unchecked guide-only consent and never sends on render", () => {
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain(state.info.consentText);
  expect(html).toContain(state.info.privacyNotice);
  expect(html).toContain('href="/guide-privacy"');
  expect(html).toContain('type="email"');
  expect(html).toContain('type="checkbox"');
  expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  expect(html).not.toContain('value="hello@');
  expect(html).not.toContain(".pdf");
  expect(state.mutate).not.toHaveBeenCalled();
});
test("missing metadata and unavailable guides do not expose a submission form", () => {
  state.loadError = true;
  expect(render(<ElevatedRoutinePage />)).not.toContain("<form");
  state.loadError = false;
  state.unavailable = true;
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain("Not available to request yet");
  expect(html).not.toContain("<form");
  expect(state.mutate).not.toHaveBeenCalled();
});
test("loading has no submission or hidden default consent", () => {
  state.loading = true;
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("<form");
});
test.each([400, 409, 429, 503])("HTTP %i is shown as failure, never accepted delivery", status => {
  state.claim.isError = true;
  state.claim.error = { status };
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Try again");
  expect(html).not.toContain("Your request was accepted");
  expect(html).not.toContain('data-testid="status-sent"');
});
test("acceptance is not falsely described as confirmed inbox delivery", () => {
  state.claim.data = { status: "sent", message: "Accepted for email delivery." };
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain("Your request was accepted");
  expect(html).toContain("not a guarantee it has reached your Inbox");
  expect(html).not.toContain("<form");
});
test("processing offers only an explicit retry, not a sent confirmation", () => {
  state.claim.data = { status: "processing", message: "Still processing." };
  const html = render(<ElevatedRoutinePage />);
  expect(html).toContain("Check again");
  expect(html).toContain("We will not retry on our own");
  expect(html).not.toContain('data-testid="status-sent"');
  expect(state.mutate).not.toHaveBeenCalled();
});
test("privacy scope is guide-only and gives the approved removal contact", () => {
  const html = render(<GuidePrivacyPage />);
  expect(html).toContain(state.info.privacyNotice);
  expect(html).toContain("does not subscribe you to marketing");
  expect(html).toContain("mailto:hello@elevatedbeautymethod.com");
});
test("library remains empty until publication approval and has no bypass download", () => {
  const empty = render(<GuidesPage />);
  expect(empty).toContain("No guides are published yet");
  expect(empty).not.toContain('href="/the-elevated-routine"');
  state.guides = [{ title: state.info.title, version: "1", pageCount: 9 }];
  const published = render(<GuidesPage />);
  expect(published).toContain(state.info.title);
  expect(published).toContain('href="/the-elevated-routine"');
  expect(published).not.toContain(".pdf");
});