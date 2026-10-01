import { useSyncExternalStore } from "react";

const authChanged = "audit-test-auth-change";
const accountSnapshot = () => {
  try {
    const tabAccount = window.sessionStorage.getItem("audit-test-tab-account");
    if (tabAccount !== null) return tabAccount;
  } catch {
    // Authentication in storage-blocked membership tests still uses the fixture.
  }
  return window.localStorage.getItem("audit-test-account") ?? "";
};

function subscribeToAccountChange(notify: () => void) {
  window.addEventListener(authChanged, notify);
  return () => window.removeEventListener(authChanged, notify);
}

export function useUser() {
  const account = useSyncExternalStore(subscribeToAccountChange, accountSnapshot);
  const verified = window.localStorage.getItem("audit-test-verified") !== "false";
  return {
    isLoaded: true,
    isSignedIn: !!account,
    user: account ? {
      id: account,
      publicMetadata: {},
      primaryEmailAddress: {
        emailAddress: `${account}@example.invalid`,
        verification: { status: verified ? "verified" : "unverified" },
      },
    } : null,
  };
}

export function useClerk() {
  return {
    openUserProfile: () => {
      window.sessionStorage.setItem("audit-test-profile-opened", "true");
    },
    signOut: async ({ redirectUrl }: { redirectUrl: string }) => {
      window.localStorage.removeItem("audit-test-account");
      window.sessionStorage.removeItem("audit-test-tab-account");
      window.dispatchEvent(new Event(authChanged));
      window.sessionStorage.setItem("audit-test-sign-out-redirect", redirectUrl);
    },
  };
}