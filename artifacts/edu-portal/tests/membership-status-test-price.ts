import type Stripe from "stripe";
import { getTestStripeClient } from "../../../scripts/src/stripeClient";

const owner = "edu-portal-membership-status-privacy-check-v1";
const name = "TEST ONLY - reusable membership privacy check (free)";
const metadata = { fixture_owner: owner };

export function isMembershipStatusTestCatalog(product: Stripe.Product, price: Stripe.Price): boolean {
  return product.metadata.fixture_owner === owner &&
    product.name === name &&
    price.metadata.fixture_owner === owner &&
    (typeof price.product === "string" ? price.product : price.product.id) === product.id &&
    price.type === "recurring" &&
    price.unit_amount === 0 &&
    price.currency === "usd" &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1;
}

// Only this guarded client can discover or create the fixture catalog. Never
// choose a price by name alone or reuse a real membership offer.
export async function membershipStatusTestCatalog(): Promise<{ stripe: Stripe; price: Stripe.Price }> {
  const stripe = await getTestStripeClient();
  const products: Stripe.Product[] = [];
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata.fixture_owner === owner) products.push(product);
  }
  if (products.length > 1) throw new Error("Ambiguous membership privacy test catalog");
  const product = products[0] ?? await stripe.products.create(
    { name, metadata },
    { idempotencyKey: `${owner}-product` },
  );
  if (product.name !== name || product.metadata.fixture_owner !== owner || !product.active) {
    throw new Error("Membership privacy test product is not owned and active");
  }

  const prices: Stripe.Price[] = [];
  for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) {
    if (price.metadata.fixture_owner === owner) prices.push(price);
  }
  if (prices.length > 1) throw new Error("Ambiguous membership privacy test price");
  const price = prices[0] ?? await stripe.prices.create(
    { product: product.id, currency: "usd", unit_amount: 0, recurring: { interval: "month" }, metadata },
    { idempotencyKey: `${owner}-price-${product.id}` },
  );
  if (!price.active || !isMembershipStatusTestCatalog(product, price)) {
    throw new Error("Membership privacy test price is not an active free monthly fixture");
  }
  return { stripe, price };
}