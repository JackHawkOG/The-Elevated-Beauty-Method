// Shared by the membership redirect and the real test-mode Stripe contract check.
export function stripeBillingPortalUrl(value: unknown): string {
  const message = "Billing is temporarily unavailable. Please try again.";
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) || !/^https:\/\//i.test(value)) {
    throw new Error(message);
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "billing.stripe.com" && !url.port && !url.username && !url.password
      && /^\/p\/session\/[^/]+\/?$/.test(url.pathname)) {
      return url.href;
    }
  } catch {
    // Treat malformed URLs the same as unexpected destinations.
  }
  throw new Error(message);
}