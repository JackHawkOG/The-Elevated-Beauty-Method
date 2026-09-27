export function useUser() {
  const account = window.localStorage.getItem("audit-test-account");
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
      window.sessionStorage.setItem("audit-test-sign-out-redirect", redirectUrl);
    },
  };
}