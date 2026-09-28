import { beforeEach, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { getTestStripeClient } from "../../../scripts/src/stripeClient";
import { membershipStatusTestCatalog } from "./membership-status-test-price";

vi.mock("../../../scripts/src/stripeClient", () => ({ getTestStripeClient: vi.fn() }));

const owner = "edu-portal-membership-status-privacy-check-v1";
const ownedProduct = {
  id: "prod_fixture", name: "TEST ONLY - reusable membership privacy check (free)",
  metadata: { fixture_owner: owner }, active: true,
} as Stripe.Product;
const ownedPrice = {
  id: "price_fixture", product: ownedProduct.id, metadata: { fixture_owner: owner },
  active: true, type: "recurring", unit_amount: 0, currency: "usd",
  recurring: { interval: "month", interval_count: 1 },
} as Stripe.Price;

function fakeStripe(products: Stripe.Product[], prices: Stripe.Price[]) {
  const createProduct = vi.fn(async () => {
    products.push(ownedProduct);
    return ownedProduct;
  });
  const createPrice = vi.fn(async () => {
    prices.push(ownedPrice);
    return ownedPrice;
  });
  const stripe = {
    products: {
      list: vi.fn(() => (async function* () { yield* products; })()),
      create: createProduct,
    },
    prices: {
      list: vi.fn(() => (async function* () { yield* prices; })()),
      create: createPrice,
    },
  } as unknown as Stripe;
  vi.mocked(getTestStripeClient).mockResolvedValue(stripe);
  return { createProduct, createPrice };
}

beforeEach(() => vi.resetAllMocks());

it("creates the marked free catalog once and reuses it on later checks", async () => {
  const { createProduct, createPrice } = fakeStripe([], []);
  expect((await membershipStatusTestCatalog()).price.id).toBe(ownedPrice.id);
  expect((await membershipStatusTestCatalog()).price.id).toBe(ownedPrice.id);
  expect(createProduct).toHaveBeenCalledTimes(1);
  expect(createPrice).toHaveBeenCalledTimes(1);
  expect(createPrice.mock.calls[0][0]).toMatchObject({
    product: ownedProduct.id, currency: "usd", unit_amount: 0,
    recurring: { interval: "month" }, metadata: { fixture_owner: owner },
  });
});

it("ignores unmarked real offers and refuses an altered owned price", async () => {
  const realProduct = { ...ownedProduct, id: "prod_real", metadata: {} } as Stripe.Product;
  const realPrice = { ...ownedPrice, id: "price_real", product: realProduct.id, metadata: {}, unit_amount: 2000 } as Stripe.Price;
  const { createProduct, createPrice } = fakeStripe([realProduct, ownedProduct], [realPrice, ownedPrice]);
  expect((await membershipStatusTestCatalog()).price.id).toBe(ownedPrice.id);
  expect(createProduct).not.toHaveBeenCalled();
  expect(createPrice).not.toHaveBeenCalled();
  fakeStripe([ownedProduct], [{ ...ownedPrice, unit_amount: 2000 }]);
  await expect(membershipStatusTestCatalog()).rejects.toThrow("not an active free monthly fixture");
});

it("fails before catalog access when the test-mode credential guard fails", async () => {
  vi.mocked(getTestStripeClient).mockRejectedValue(new Error("Membership fixtures require Stripe test mode."));
  await expect(membershipStatusTestCatalog()).rejects.toThrow("Stripe test mode");
});