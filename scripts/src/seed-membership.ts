import { getUncachableStripeClient } from "./stripeClient";

const stripe = await getUncachableStripeClient();
let product = (await stripe.products.search({ query: "metadata['offer_key']:'elevated_method_2026'" })).data[0];
if (!product) product = await stripe.products.create({
  name: "The Elevated Method",
  metadata: { offer_key: "elevated_method_2026" },
});
for (const [key, amount] of [["founding_2026", 2400], ["standard_2026", 4800]] as const) {
  const existing = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  if (existing.data.some(p => p.lookup_key === key && p.unit_amount === amount && p.recurring?.interval === "month")) continue;
  await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
    lookup_key: key,
  });
}
console.log("Membership prices are ready in Stripe.");