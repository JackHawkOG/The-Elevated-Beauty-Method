import { checkStripeBillingLinks } from "./stripe-billing-links-check";

checkStripeBillingLinks().then(
  () => console.log("PASS: Real test-mode Stripe portal URL satisfies the membership safety rules; disposable customer cleaned up. No session opened or published."),
  error => {
    console.error(error instanceof Error ? error.message : "Stripe billing link check failed.");
    process.exitCode = 1;
  },
);