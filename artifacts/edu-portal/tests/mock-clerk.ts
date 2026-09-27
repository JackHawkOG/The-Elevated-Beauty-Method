export function useUser() {
  const account = window.localStorage.getItem("audit-test-account");
  return {
    isLoaded: true,
    isSignedIn: !!account,
    user: account ? { id: account, primaryEmailAddress: { emailAddress: `${account}@example.invalid` } } : null,
  };
}

export function useClerk() {
  return { signOut: async () => {} };
}