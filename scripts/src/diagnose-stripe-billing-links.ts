import { getTestStripeClient } from "./stripeClient";
import { stripeBillingPortalUrl } from "../../artifacts/edu-portal/src/lib/stripe-billing-portal-url";

// Diagnostic output is structural only: session URLs are bearer credentials.
function describe(session: unknown) {
  const value = session as { id?: unknown; object?: unknown; livemode?: unknown; url?: unknown; lastResponse?: { statusCode?: number; requestId?: string; headers?: Record<string, string> } };
  let valid = false;
  try { stripeBillingPortalUrl(value.url); valid = true; } catch { /* Rejected safely. */ }
  let shape = "missing-or-malformed";
  let queryPresent = false;
  let fragmentPresent = false;
  try {
    const url = new URL(String(value.url));
    queryPresent = Boolean(url.search);
    fragmentPresent = Boolean(url.hash);
    shape = url.protocol !== "https:" ? "non-https"
      : url.hostname !== "billing.stripe.com" ? "unexpected-host"
      : url.pathname === "/p/session" && url.searchParams.getAll("secret").length === 1
        && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("secret") ?? "") ? "query-session-identifier-present"
      : /^\/p\/session\/?$/.test(url.pathname) ? "session-identifier-missing"
      : /^\/p\/session\/[^/]+\/?$/.test(url.pathname) ? "session-identifier-present"
      : "unexpected-path";
  } catch { /* No URL contents in diagnostics. */ }
  return {
    objectIsPortalSession: value.object === "billing_portal.session",
    sessionIdPresent: typeof value.id === "string" && value.id.startsWith("bps_"),
    livemode: typeof value.livemode === "boolean" ? value.livemode : "not-returned",
    urlShape: shape,
    queryPresent,
    fragmentPresent,
    acceptedByMembership: valid,
    status: value.lastResponse?.statusCode,
    requestIdPresent: Boolean(value.lastResponse?.requestId),
  };
}

async function main() {
  const stripe = await getTestStripeClient();
  const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const configuration = configurations.data.find(c =>
    c.livemode === false && c.features.subscription_cancel?.enabled
    && c.features.subscription_cancel.mode === "at_period_end"
    && c.features.payment_method_update?.enabled && !c.features.subscription_update?.enabled,
  );
  if (!configuration) throw new Error("Compatible existing test portal configuration required.");
  const customer = await stripe.customers.create({
    name: "TEST ONLY - billing portal response investigation",
    metadata: { fixture_owner: "billing-portal-url-contract-check" },
  });
  try {
    if (customer.livemode !== false) throw new Error("Expected test customer");
    const params = { customer: customer.id, configuration: configuration.id, return_url: "https://example.invalid/membership" };
    const results = [
      ["sdk-default", describe(await stripe.billingPortal.sessions.create(params))],
      ["raw-default", describe(await stripe.rawRequest("POST", "/v1/billing_portal/sessions", params))],
      ["raw-2024-06-20", describe(await stripe.rawRequest("POST", "/v1/billing_portal/sessions", params, { apiVersion: "2024-06-20" }))],
    ] as const;
    for (const [label, result] of results) console.log(label, result);
    if (results.some(([, result]) => !result.acceptedByMembership || result.livemode !== false)) {
      throw new Error("Test portal response did not satisfy the membership safety rules.");
    }
  } finally {
    const deleted = await stripe.customers.del(customer.id);
    if (deleted.deleted !== true) throw new Error("Disposable test customer deletion was not confirmed.");
    console.log("Disposable test customer deleted.");
  }
}

main().catch(() => {
  console.error("Stripe billing response investigation failed; provider details withheld.");
  process.exitCode = 1;
});