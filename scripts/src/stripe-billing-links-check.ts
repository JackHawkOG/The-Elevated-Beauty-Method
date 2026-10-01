import { getTestStripeClient } from "./stripeClient";
import { stripeBillingPortalUrl } from "../../artifacts/edu-portal/src/lib/stripe-billing-portal-url";

// No app database, member identity, browser, or existing customer is used.
// Stripe portal sessions cannot be explicitly expired; deleting the disposable
// customer removes its billing data. Never log or persist the bearer session URL.
export async function checkStripeBillingLinks(): Promise<void> {
  const stripe = await getTestStripeClient(); // Refuses live credentials before any Stripe writes.
  let customerId: string | undefined;
  let stage = "finding an existing active test portal configuration";
  const failures: string[] = [];
  try {
    // Do not create configurations: Stripe's first configuration becomes the
    // account default and cannot be deactivated. Never modify shared settings.
    const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
    const configuration = configurations.data.find(c =>
      c.livemode === false && c.features.subscription_cancel?.enabled
      && c.features.subscription_cancel.mode === "at_period_end"
      && c.features.payment_method_update?.enabled && !c.features.subscription_update?.enabled,
    );
    if (!configuration) {
      failures.push("Prerequisite missing: configure a test-mode billing portal with payment updates and cancellation at period end enabled, and subscription updates disabled.");
      return;
    }
    stage = "creating a disposable test customer";
    const customer = await stripe.customers.create({
      name: "TEST ONLY - billing portal URL contract check",
      metadata: { fixture_owner: "billing-portal-url-contract-check" },
    });
    customerId = customer.id;
    if (customer.livemode !== false) throw new Error("Expected test customer");
    stage = "obtaining a real test-mode portal session";
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configuration.id,
      return_url: "https://example.invalid/membership",
    });
    stage = "validating Stripe's portal URL against the membership destination rules; Stripe's URL format may have changed";
    stripeBillingPortalUrl(session.url);
  } catch {
    // SDK errors can include request details. Do not leak a session URL in output.
    failures.push(`Stripe billing link check failed while ${stage}.`);
  } finally {
    if (customerId) {
      try {
        await stripe.customers.del(customerId);
      } catch {
        failures.push("Could not delete the disposable Stripe test customer.");
      }
    }
    if (failures.length) throw new Error(failures.join(" "));
  }
}