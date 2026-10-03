// Shared by the membership redirect and the real test-mode Stripe contract check.
export function stripeBillingPortalUrl(value: unknown): string {
  const message = "Billing is temporarily unavailable. Please try again.";
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || !/^https:\/\//i.test(value)) {
    throw new Error(message);
  }
  try {
    const url = new URL(value);
    // Stripe documents both a path token and /p/session?secret=TOKEN.
    // https://docs.stripe.com/api/customer_portal/sessions/create
    // A bare session path still grants no destination approval.
    const secrets = url.searchParams.getAll("secret");
    const querySession = url.pathname === "/p/session" && secrets.length === 1
      && /^[A-Za-z0-9_-]+$/.test(secrets[0]);
    const pathSession = /^\/p\/session\/[^/]+\/?$/.test(url.pathname);
    if (url.protocol === "https:" && url.hostname === "billing.stripe.com" && !url.port && !url.username && !url.password
      && !url.hash && (pathSession || querySession)) {
      return url.href;
    }
  } catch {
    // Treat malformed URLs the same as unexpected destinations.
  }
  throw new Error(message);
}