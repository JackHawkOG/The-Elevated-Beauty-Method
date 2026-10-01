import { useEffect } from "react";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import type { QueryClient } from "@tanstack/react-query";

const profileSignalKey = (memberId: string) => `edu-portal:profile-changed:${memberId}`;

// Send only an invalidation signal, never profile details or a draft.
export function notifyProfileChanged(memberId: string) {
  const key = profileSignalKey(memberId);
  try {
    const channel = new BroadcastChannel(key);
    channel.postMessage("changed");
    channel.close();
  } catch {
    // Storage events support browsers without BroadcastChannel.
  }
  try {
    window.localStorage.setItem(key, `${Date.now()}:${Math.random()}`);
  } catch {
    // Focus/visibility and periodic refresh still work when storage is blocked.
  }
}

export function useProfileFreshness(memberId: string | undefined, queryClient: QueryClient) {
  useEffect(() => {
    if (!memberId) return;
    const key = profileSignalKey(memberId);
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey(), exact: true });
    };
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key && event.newValue) refresh();
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(key);
      channel.onmessage = event => {
        if (event.data === "changed") refresh();
      };
    } catch {
      // The storage listener and lifecycle refreshes remain available.
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    // Also recover missed signals (e.g. messaging and storage both unavailable).
    const interval = window.setInterval(refreshVisible, 30_000);
    return () => {
      channel?.close();
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [memberId, queryClient]);
}