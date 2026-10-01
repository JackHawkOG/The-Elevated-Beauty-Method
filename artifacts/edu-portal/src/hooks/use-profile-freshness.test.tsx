// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { notifyProfileChanged, useProfileFreshness } from "./use-profile-freshness";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("account-scoped signals refresh only the profile and listeners leave with the session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: { data: string }) => void) | null = null;
    close = vi.fn();
    postMessage = vi.fn();
    constructor(public name: string) { channels.push(this); }
  }
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const container = document.createElement("div");
  const root = createRoot(container);
  function Listener({ memberId }: { memberId?: string }) {
    useProfileFreshness(memberId, client);
    return null;
  }
  try {
    await act(async () => root.render(<Listener memberId="member-a" />));
    channels[0].onmessage?.({ data: "changed" });
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: getGetMeQueryKey(), exact: true });
    invalidate.mockClear();
    window.dispatchEvent(new StorageEvent("storage", { key: "edu-portal:profile-changed:member-b", newValue: "changed" }));
    expect(invalidate).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: channels[0].name, newValue: "changed" }));
    expect(invalidate).toHaveBeenCalledOnce();
    notifyProfileChanged("member-a");
    expect(channels[1].postMessage).toHaveBeenCalledWith("changed");
    expect(channels[1].close).toHaveBeenCalledOnce();
    expect(localStorage.getItem(channels[0].name)).not.toContain("bio");

    await act(async () => root.render(<Listener memberId="member-b" />));
    expect(channels[0].close).toHaveBeenCalledOnce();
    invalidate.mockClear();
    window.dispatchEvent(new StorageEvent("storage", { key: channels[0].name, newValue: "changed" }));
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => root.render(<Listener />));
    expect(channels[2].close).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(invalidate).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

test("blocked messaging and storage still allow focus, reconnect and periodic refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", class { constructor() { throw new Error("blocked"); } });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const root = createRoot(document.createElement("div"));
  function Listener() {
    useProfileFreshness("member", client);
    return null;
  }
  try {
    await act(async () => root.render(<Listener />));
    expect(() => notifyProfileChanged("member")).not.toThrow();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidate).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30_000);
    expect(invalidate).toHaveBeenCalledTimes(4);
    await act(async () => root.unmount());
    vi.advanceTimersByTime(30_000);
    expect(invalidate).toHaveBeenCalledTimes(4);
  } finally {
    client.clear();
  }
});