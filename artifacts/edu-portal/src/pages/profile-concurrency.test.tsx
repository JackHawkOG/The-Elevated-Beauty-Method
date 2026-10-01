// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey, type UserProfile } from "@workspace/api-client-react";

vi.mock("@/components/layout", () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ProfileEditForm } from "./profile";

afterEach(() => vi.unstubAllGlobals());

const initial: UserProfile = {
  id: 1, clerkId: "member", email: "member@example.invalid", displayName: "My unsaved name",
  bio: "", membershipTier: "Free", createdAt: "2026-01-01T00:00:00.000Z",
  profileVersion: "11111111-1111-1111-1111-111111111111",
};
const latest: UserProfile = {
  ...initial, displayName: "Saved elsewhere", bio: "Saved elsewhere bio",
  profileVersion: "22222222-2222-2222-2222-222222222222",
};

test.each(["Keep my edits and review before saving", "Use latest saved details"])(
  "a conflict preserves edits and requires an explicit choice: %s",
  async choice => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const bodies: Record<string, unknown>[] = [];
    const saved = { ...latest, profileVersion: "33333333-3333-3333-3333-333333333333" };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      bodies.push(body);
      return new Response(JSON.stringify(bodies.length === 1
        ? { error: "Conflict", currentProfile: latest }
        : { ...saved, displayName: body.displayName, bio: body.bio }), {
        status: bodies.length === 1 ? 409 : 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(getGetMeQueryKey(), initial);
    const onSuccess = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (profile: UserProfile) => root.render(
      <QueryClientProvider client={client}>
        <ProfileEditForm initialProfile={profile} onSuccess={onSuccess} />
      </QueryClientProvider>,
    );
    const submit = () => act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    async function settle(until: () => boolean) {
      for (let i = 0; i < 50 && !until(); i++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      }
      expect(until()).toBe(true);
    }
    try {
      await act(async () => render(initial));
      // Incoming refetches must not silently rebase or replace an in-progress edit.
      await act(async () => render(latest));
      expect(container.querySelector("input")!.value).toBe(initial.displayName);
      await submit();
      await settle(() => !!container.querySelector('[role="alert"]'));
      expect(bodies).toEqual([{ displayName: initial.displayName, bio: "", profileVersion: initial.profileVersion }]);
      expect(container.textContent).toContain("Saved name: Saved elsewhere");
      expect(container.querySelector("input")!.value).toBe(initial.displayName);
      expect(container.querySelector("textarea")!.value).toBe("");
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      expect(onSuccess).not.toHaveBeenCalled();
      await submit();
      expect(bodies).toHaveLength(1);
      await act(async () => {
        Array.from(container.querySelectorAll("button")).find(button => button.textContent === choice)!.click();
      });
      expect(bodies).toHaveLength(1); // Choosing does not automatically overwrite anything.
      const useSaved = choice === "Use latest saved details";
      expect(container.querySelector("input")!.value).toBe(useSaved ? latest.displayName : initial.displayName);
      await submit();
      await settle(() => onSuccess.mock.calls.length === 1);
      expect(bodies[1]).toEqual({
        profileVersion: latest.profileVersion,
        displayName: useSaved ? latest.displayName : initial.displayName,
        bio: useSaved ? latest.bio : "",
      });
      expect(client.getQueryData<UserProfile>(getGetMeQueryKey())).toMatchObject({
        ...bodies[1], profileVersion: saved.profileVersion,
      });
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  },
);