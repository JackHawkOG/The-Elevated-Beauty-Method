import { describe, expect, it } from "vitest";
import { membershipCleanupMocks, relatedMemberColumns } from "./membership-status-cleanup-mocks";

type Mocks = ReturnType<typeof membershipCleanupMocks>;
function protectedRecords(mock: Mocks) {
  const state = mock.snapshot();
  return {
    identities: state.identities.filter(row => row.id === "user_member"),
    members: state.members.filter(row => row.clerk_id === "user_member"),
    checkouts: state.checkouts.filter(row => row.clerk_id === "user_member"),
    related: state.related,
    products: state.products.filter(row => row.id === "prod_member"),
    prices: state.prices.filter(row => row.id === "price_member"),
    customers: state.customers.filter(row => row.id === "cus_member"),
    subscriptions: state.subscriptions.filter(row => row.id === "sub_member"),
    invoices: state.invoices.filter(row => row.id === "in_member"),
  };
}
async function refusesWithoutChanges(mock: Mocks, message: RegExp) {
  const before = mock.snapshot();
  await expect(mock.run()).rejects.toThrow(message);
  expect(mock.snapshot()).toEqual(before);
  expect(mock.mutations()).toEqual([]);
  expect(mock.pool.end).toHaveBeenCalledOnce();
  if (mock.pool.connect.mock.calls.length) {
    expect(mock.events).toContain("ROLLBACK");
    expect(mock.connection.release).toHaveBeenCalledOnce();
  }
}

function useSharedCatalog(mock: Mocks) {
  Object.assign(mock.state.products[0], {
    name: "TEST ONLY - reusable membership privacy check (free)",
    metadata: { fixture_owner: "edu-portal-membership-status-privacy-check-v1" },
  });
  const patch = {
    type: "recurring",
    metadata: { fixture_owner: "edu-portal-membership-status-privacy-check-v1" },
  };
  Object.assign(mock.state.prices[0], patch);
  Object.assign(mock.state.subscriptions[0].items.data[0].price, patch);
}

describe("full membership fixture cleanup using only disposable mocks", () => {
  it("dry-runs all three systems without writes", async () => {
    const mock = membershipCleanupMocks();
    const before = mock.snapshot();
    await mock.run([]);
    expect(mock.snapshot()).toEqual(before);
    expect(mock.mutations()).toEqual([]);
    expect(mock.stripe.invoices.list).toHaveBeenCalledWith({ customer: "cus_fixture", limit: 100 });
    expect(mock.connection.query).toHaveBeenCalledWith("SELECT * FROM users WHERE clerk_id = $1", ["user_fixture"]);
    expect(mock.events).toContain("COMMIT");
    expect(mock.connection.release).toHaveBeenCalledOnce();
    expect(mock.pool.end).toHaveBeenCalledOnce();
  });

  it("commits exact-ID database deletion before Stripe and Clerk, preserving unrelated records", async () => {
    const mock = membershipCleanupMocks();
    const before = protectedRecords(mock);
    await mock.run();
    expect(mock.mutations()).toEqual([
      "DELETE FROM membership_checkouts WHERE clerk_id = $1",
      "DELETE FROM users WHERE clerk_id = $1 AND email = $2",
      "cancel:sub_fixture", "customer-delete:cus_fixture",
       "clerk-delete:user_fixture", "price-archive:price_fixture", "product-archive:prod_fixture",
    ]);
    expect(mock.events.indexOf("COMMIT")).toBeLessThan(mock.events.indexOf("cancel:sub_fixture"));
    expect(mock.events.indexOf("release")).toBeLessThan(mock.events.indexOf("cancel:sub_fixture"));
    expect(mock.state.members.map(row => row.clerk_id)).toEqual(["user_member"]);
    expect(mock.state.checkouts.map(row => row.clerk_id)).toEqual(["user_member"]);
    expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
    expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
    expect(mock.state.subscriptions[0].status).toBe("canceled");
    expect(mock.state.prices[0].active).toBe(false);
    expect(mock.state.products[0].active).toBe(false);
    expect(mock.stripe.prices.update).toHaveBeenCalledExactlyOnceWith("price_fixture", { active: false });
    expect(mock.stripe.products.update).toHaveBeenCalledExactlyOnceWith("prod_fixture", { active: false });
    expect(protectedRecords(mock)).toEqual(before);
    const after = mock.snapshot();
    mock.events.length = 0;
    await mock.run();
    expect(mock.snapshot()).toEqual(after);
    expect(mock.mutations()).toEqual([]);
  });

  it.each(["unmarked", "modified", "young"] as const)("never touches a %s identity", async kind => {
    const mock = membershipCleanupMocks();
    if (kind === "unmarked") mock.identity.privateMetadata = {};
    if (kind === "modified") mock.identity.firstName = "Real member";
    if (kind === "young") mock.identity.createdAt = Date.now();
    const before = mock.snapshot();
    await mock.run();
    expect(mock.snapshot()).toEqual(before);
    expect(mock.mutations()).toEqual([]);
    expect(mock.pool.connect).not.toHaveBeenCalled();
    expect(mock.stripe.customers.list).not.toHaveBeenCalled();
  });

  it("cleans a founding-role fixture with its distinct checkout and cancellation schedule", async () => {
    const mock = membershipCleanupMocks();
    const email = "membership-status-b-abcdef123456+clerk_test@example.com";
    mock.identity.emailAddresses[0].emailAddress = email;
    mock.state.members[0].email = email;
    mock.state.checkouts[0].kind = "founding";
    mock.state.customers[0].email = email;
    mock.state.subscriptions[0].cancel_at = mock.state.subscriptions[0].created + 5 * 86400;
    const before = protectedRecords(mock);
    await mock.run();
    expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
    expect(protectedRecords(mock)).toEqual(before);
  });

  it.each(["active", "canceled"] as const)(
    "cleans a stale %s subscription without archiving the shared free catalog", async status => {
    const mock = membershipCleanupMocks();
    useSharedCatalog(mock);
    mock.state.subscriptions[0].status = status;
    if (status === "canceled") mock.state.subscriptions[0].cancel_at = null;
    const protectedBefore = protectedRecords(mock);
    const before = structuredClone({ products: mock.state.products, prices: mock.state.prices });
    await mock.run();
    expect(mock.mutations()).toEqual([
      "DELETE FROM membership_checkouts WHERE clerk_id = $1",
      "DELETE FROM users WHERE clerk_id = $1 AND email = $2",
      ...(status === "active" ? ["cancel:sub_fixture"] : []),
      "customer-delete:cus_fixture", "clerk-delete:user_fixture",
    ]);
    expect(mock.state.members.map(row => row.clerk_id)).toEqual(["user_member"]);
    expect(mock.state.checkouts.map(row => row.clerk_id)).toEqual(["user_member"]);
    expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
    expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
    expect(mock.state.subscriptions[0].status).toBe("canceled");
    expect(mock.stripe.products.retrieve).toHaveBeenCalledWith("prod_fixture");
    expect(mock.stripe.products.update).not.toHaveBeenCalled();
    expect(mock.stripe.prices.update).not.toHaveBeenCalled();
    expect({ products: mock.state.products, prices: mock.state.prices }).toEqual(before);
    expect(protectedRecords(mock)).toEqual(protectedBefore);
  });

  it.each([
    "missing-product-marker", "altered-product-marker",
    "missing-price-marker", "altered-price-marker",
    "changed-product-name", "mismatched-product-reference",
  ] as const)(
    "rejects shared catalog with %s before any database or remote deletion", async kind => {
      const mock = membershipCleanupMocks();
      useSharedCatalog(mock);
      const product = mock.state.products[0];
      const price = mock.state.prices[0];
      const subscriptionPrice = mock.state.subscriptions[0].items.data[0].price;
      if (kind === "missing-product-marker") product.metadata = {};
      if (kind === "altered-product-marker") product.metadata = { fixture_owner: "another-owner" };
      if (kind === "missing-price-marker" || kind === "altered-price-marker") {
        const metadata = kind === "missing-price-marker" ? {} : { fixture_owner: "another-owner" };
        price.metadata = { ...metadata };
        subscriptionPrice.metadata = { ...metadata };
      }
      if (kind === "changed-product-name") product.name = "Real membership";
      if (kind === "mismatched-product-reference") {
        product.id = "prod_mismatched";
        // Keep all ownership markers valid, but return a different product ID
        // for the subscription's reference to exercise the reference guard.
        mock.stripe.products.retrieve.mockResolvedValue(structuredClone(product));
      }

      await refusesWithoutChanges(mock, /Unowned Stripe subscription/);
      expect(mock.stripe.products.retrieve).toHaveBeenCalledExactlyOnceWith("prod_fixture");
      expect(mock.pool.connect).not.toHaveBeenCalled();
      expect(mock.connection.query).not.toHaveBeenCalled();
      expect(mock.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(mock.stripe.customers.del).not.toHaveBeenCalled();
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel:sub_fixture", "customer-delete:cus_fixture", "clerk-delete:user_fixture"])(
    "resumes shared-catalog cleanup after a failed %s without archiving reusable billing", async failure => {
      const mock = membershipCleanupMocks();
      useSharedCatalog(mock);
      const catalogBefore = structuredClone({ products: mock.state.products, prices: mock.state.prices });
      const protectedBefore = protectedRecords(mock);
      mock.failOnce(failure);
      await expect(mock.run()).rejects.toThrow(`Injected ${failure} failure`);
      expect(mock.events).toContain("COMMIT");
      expect(mock.state.members.map(row => row.clerk_id)).toEqual(["user_member"]);
      expect(mock.state.checkouts.map(row => row.clerk_id)).toEqual(["user_member"]);
      expect(mock.state.identities.some(row => row.id === "user_fixture")).toBe(true);
      expect({ products: mock.state.products, prices: mock.state.prices }).toEqual(catalogBefore);

      await mock.run();
      expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
      expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
      expect(mock.state.subscriptions[0].status).toBe("canceled");
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      expect({ products: mock.state.products, prices: mock.state.prices }).toEqual(catalogBefore);
      expect(protectedRecords(mock)).toEqual(protectedBefore);
      const after = mock.snapshot();
      mock.events.length = 0;
      await mock.run();
      expect(mock.snapshot()).toEqual(after);
      expect(mock.mutations()).toEqual([]);
    },
  );

  it("finds an eligible fixture after a full page of unrelated identities", async () => {
    const mock = membershipCleanupMocks();
    const unrelated = structuredClone(mock.state.identities[1]);
    mock.state.identities.unshift(...Array.from({ length: 100 }, (_, index) => ({
      ...structuredClone(unrelated), id: `user_unrelated_${index}`,
    })));
    const before = mock.snapshot().identities.filter(row => row.id !== "user_fixture");
    await mock.run();
    expect(mock.clerk.users.getUserList.mock.calls.slice(0, 2)).toEqual([
      [{ limit: 100, offset: 0 }], [{ limit: 100, offset: 100 }],
    ]);
    expect(mock.state.identities).toEqual(before);
    expect(mock.clerk.users.deleteUser).toHaveBeenCalledExactlyOnceWith("user_fixture");
  });

  it.each([1, 2])("rejects identity changes at recheck %i before any deletion", async recheck => {
    const mock = membershipCleanupMocks();
    const getUser = mock.clerk.users.getUser.getMockImplementation()!;
    let calls = 0;
    mock.clerk.users.getUser.mockImplementation(async id => {
      const user = await getUser(id);
      if (++calls === recheck) user.publicMetadata = { role: "owner" };
      return user;
    });
    await refusesWithoutChanges(mock, /Fixture identity changed/);
  });

  it.each(["COMMIT", "cancel:sub_fixture", "customer-delete:cus_fixture"])(
    "preserves an identity modified after %s and stops subsequent remote writes", async boundary => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      mock.afterOnce(boundary, () => { mock.identity.publicMetadata = { role: "owner" }; });
      await expect(mock.run()).rejects.toThrow(/Fixture identity changed/);
      expect(mock.events).toContain("COMMIT");
      expect(mock.state.identities).toContainEqual(mock.identity);
      expect(mock.identity.publicMetadata).toEqual({ role: "owner" });
      expect(mock.stripe.subscriptions.cancel).toHaveBeenCalledTimes(boundary === "COMMIT" ? 0 : 1);
      expect(mock.stripe.customers.del).toHaveBeenCalledTimes(boundary === "customer-delete:cus_fixture" ? 1 : 0);
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      expect(protectedRecords(mock)).toEqual(unrelated);
      const beforeRetry = mock.snapshot();
      mock.events.length = 0;
      await mock.run();
      expect(mock.snapshot()).toEqual(beforeRetry);
      expect(mock.mutations()).toEqual([]);
    },
  );

  it.each(["email", "marker", "age", "createdAt", "id", "name"] as const)(
    "refuses an identity's %s change after commit before canceling Stripe", async kind => {
      const mock = membershipCleanupMocks();
      mock.afterOnce("COMMIT", () => {
        if (kind === "email") mock.identity.emailAddresses[0].emailAddress = "member@example.com";
        if (kind === "marker") mock.identity.privateMetadata = {};
        if (kind === "age") mock.identity.createdAt = Date.now();
        if (kind === "createdAt") mock.identity.createdAt -= 60_000;
        if (kind === "id") {
          mock.clerk.users.getUser.mockResolvedValue({ ...structuredClone(mock.identity), id: "user_member" });
        }
        if (kind === "name") mock.identity.firstName = "In use";
      });
      await expect(mock.run()).rejects.toThrow(/Fixture identity changed/);
      expect(mock.state.identities.some(row => row.id === "user_fixture")).toBe(true);
      expect(mock.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(mock.stripe.customers.del).not.toHaveBeenCalled();
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
    },
  );

  const billingChanges = ["paid-invoice", "foreign-invoice", "extra-subscription",
    "foreign-subscription", "customer-change", "customer-email", "replacement-customer",
    "replacement-subscription", "charge", "card", "catalog-change", "extra-price"] as const;
  function changeBilling(mock: Mocks, kind: typeof billingChanges[number]) {
    if (kind === "paid-invoice") mock.state.invoices[0].total = 2500;
    if (kind === "foreign-invoice") mock.state.invoices[0].parent.subscription_details.subscription = "sub_member";
    if (kind === "extra-subscription") mock.state.subscriptions.push({
      ...structuredClone(mock.state.subscriptions[1]), id: "sub_extra", customer: "cus_fixture",
    });
    if (kind === "foreign-subscription") mock.state.subscriptions[0].items.data[0].price = structuredClone(mock.state.prices[1]);
    if (kind === "customer-change") mock.state.customers[0].balance = 2500;
    if (kind === "customer-email") mock.state.customers[0].email = "changed@example.com";
    if (kind === "replacement-customer") {
      mock.state.customers[0].id = "cus_replacement";
      mock.state.subscriptions[0].customer = "cus_replacement";
      mock.state.invoices[0].customer = "cus_replacement";
    }
    if (kind === "replacement-subscription") {
      mock.state.subscriptions[0].id = "sub_replacement";
      mock.state.invoices[0].parent.subscription_details.subscription = "sub_replacement";
    }
    if (kind === "charge") mock.state.charges.push({ customer: "cus_fixture" });
    if (kind === "card") mock.state.cards.push({ customer: "cus_fixture" });
    if (kind === "catalog-change") mock.state.prices[0].unit_amount = 2500;
    if (kind === "extra-price") mock.state.prices.push({ ...mock.state.prices[0], id: "price_other" });
  }

  it.each(billingChanges.flatMap(kind =>
    ["COMMIT", "cancel:sub_fixture"].map(boundary => ({ kind, boundary }))))(
    "preserves $kind billing introduced after $boundary", async ({ kind, boundary }) => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      let billingAfterChange: unknown;
      mock.afterOnce(boundary, () => {
        changeBilling(mock, kind);
        const { identities, members, checkouts, related, ...billing } = mock.snapshot();
        billingAfterChange = billing;
      });
      await expect(mock.run()).rejects.toThrow(/billing changed|Additional billing|Additional Stripe subscriptions|Unowned Stripe|Additional test prices/);
      const { identities, members, checkouts, related, ...billing } = mock.snapshot();
      expect(billing).toEqual(billingAfterChange);
      expect(mock.stripe.subscriptions.cancel).toHaveBeenCalledTimes(boundary === "COMMIT" ? 0 : 1);
      expect(mock.stripe.customers.del).not.toHaveBeenCalled();
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      expect(mock.state.identities.some(row => row.id === "user_fixture")).toBe(true);
      expect(protectedRecords(mock)).toEqual(unrelated);
    },
  );

  it.each(["COMMIT", "cancel:sub_fixture", "customer-delete:cus_fixture"])(
    "fails explicitly on a remote ownership lookup outage after %s and safely retries", async boundary => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      mock.afterOnce(boundary, () => mock.failOnce("clerk-get:user_fixture"));
      await expect(mock.run()).rejects.toThrow(/Injected clerk-get:user_fixture failure/);
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.state.identities.some(row => row.id === "user_fixture")).toBe(true);
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      await mock.run();
      expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
      expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
      expect(mock.state.products[0].active).toBe(false);
      expect(mock.state.prices[0].active).toBe(false);
      expect(mock.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
      expect(protectedRecords(mock)).toEqual(unrelated);
    },
  );

  it.each(["COMMIT", "cancel:sub_fixture", "customer-delete:cus_fixture"])(
    "stops on a Stripe recheck outage after %s and resumes only after verification recovers", async boundary => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      mock.afterOnce(boundary, () => mock.failOnce("product-list"));
      await expect(mock.run()).rejects.toThrow(/Injected product-list failure/);
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.stripe.customers.del).toHaveBeenCalledTimes(boundary === "customer-delete:cus_fixture" ? 1 : 0);
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      await mock.run();
      expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
      expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
      expect(mock.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
      expect(protectedRecords(mock)).toEqual(unrelated);
    },
  );

  it.each(["subscription", "both"] as const)(
    "checks the final Clerk boundary even when %s billing is already absent", async absent => {
      const mock = membershipCleanupMocks();
      mock.state.subscriptions = mock.state.subscriptions.filter(row => row.id !== "sub_fixture");
      mock.state.invoices = mock.state.invoices.filter(row => row.customer !== "cus_fixture");
      if (absent !== "subscription") mock.state.customers = mock.state.customers.filter(row => row.id !== "cus_fixture");
      mock.state.checkouts = mock.state.checkouts.filter(row => row.clerk_id !== "user_fixture");
      mock.afterOnce("COMMIT", () => { mock.identity.lastName = "Keep me"; });
      await expect(mock.run()).rejects.toThrow(/Fixture identity changed/);
      expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
      expect(mock.stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(mock.stripe.customers.del).not.toHaveBeenCalled();
    },
  );

  it("preserves a new customer created after the old customer is deleted", async () => {
    const mock = membershipCleanupMocks();
    const replacement = { ...structuredClone(mock.state.customers[0]), id: "cus_new" };
    mock.afterOnce("customer-delete:cus_fixture", () => mock.state.customers.push(replacement));
    await expect(mock.run()).rejects.toThrow(/Fixture billing changed/);
    expect(mock.state.customers).toContainEqual(replacement);
    expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
    expect(mock.stripe.customers.del).toHaveBeenCalledExactlyOnceWith("cus_fixture");
    expect(mock.stripe.prices.update).not.toHaveBeenCalled();
  });

  it("refuses a shared run catalog when its second identity is still in use", async () => {
    const mock = membershipCleanupMocks();
    mock.state.identities.push({
      ...structuredClone(mock.identity), id: "user_busy", createdAt: Date.now(),
      emailAddresses: [{ emailAddress: "membership-status-b-abcdef123456+clerk_test@example.com" }],
    });
    await refusesWithoutChanges(mock, /Another identity in this run is not eligible/);
  });

  it.each(["profile", "checkout", "subscription-owner", "customer-owner", "shared-email"] as const)(
    "refuses unrelated database data: %s", async kind => {
      const mock = membershipCleanupMocks();
      if (kind === "profile") mock.state.members[0].bio = "Real profile";
      if (kind === "checkout") mock.state.checkouts[0].stripe_subscription_id = "sub_member";
      if (kind === "subscription-owner") mock.state.checkouts[1].stripe_subscription_id = "sub_fixture";
      if (kind === "customer-owner") mock.state.checkouts[1].stripe_customer_id = "cus_fixture";
      if (kind === "shared-email") mock.state.members[1].email = mock.identity.emailAddresses[0].emailAddress;
      await refusesWithoutChanges(mock, /Non-fixture|belongs to another member|Email is shared/);
    },
  );

  it.each(relatedMemberColumns)("preserves linked member data in %s.%s", async (table, column) => {
    const mock = membershipCleanupMocks();
    mock.state.related[table].push({ [column]: "user_fixture", value: "private member data" });
    await refusesWithoutChanges(mock, /Related member data/);
  });

  it.each(["paid-invoice", "foreign-invoice", "extra-subscription", "foreign-subscription",
    "customer-change", "charge", "card", "catalog-change", "extra-price"] as const)(
    "refuses unrelated Stripe billing: %s", async kind => {
      const mock = membershipCleanupMocks();
      if (kind === "paid-invoice") mock.state.invoices[0].total = 2500;
      if (kind === "foreign-invoice") mock.state.invoices[0].parent.subscription_details.subscription = "sub_member";
      if (kind === "extra-subscription") mock.state.subscriptions.push({
        ...structuredClone(mock.state.subscriptions[1]), customer: "cus_fixture",
      });
      if (kind === "foreign-subscription") mock.state.subscriptions[0].items.data[0].price = structuredClone(mock.state.prices[1]);
      if (kind === "customer-change") mock.state.customers[0].balance = 2500;
      if (kind === "charge") mock.state.charges.push({ customer: "cus_fixture" });
      if (kind === "card") mock.state.cards.push({ customer: "cus_fixture" });
      if (kind === "catalog-change") mock.state.prices[0].unit_amount = 2500;
      if (kind === "extra-price") mock.state.prices.push({ ...mock.state.prices[0], id: "price_other" });
      await refusesWithoutChanges(mock, /Additional billing|Additional Stripe subscriptions|Unowned Stripe|Additional test prices/);
      expect(mock.pool.connect).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a billing listing is incomplete", async () => {
    const mock = membershipCleanupMocks();
    mock.stripe.invoices.list.mockResolvedValue({ data: [], has_more: true });
    await refusesWithoutChanges(mock, /Additional billing records/);
  });

  it("rolls back a midway database failure and never calls remote deletion", async () => {
    const mock = membershipCleanupMocks();
    const before = mock.snapshot();
    mock.failOnce("DELETE FROM users WHERE clerk_id = $1 AND email = $2");
    await expect(mock.run()).rejects.toThrow(/Injected DELETE/);
    expect(mock.snapshot()).toEqual(before);
    expect(mock.events).toContain("ROLLBACK");
    expect(mock.events).not.toContain("COMMIT");
    expect(mock.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(mock.clerk.users.deleteUser).not.toHaveBeenCalled();
    expect(mock.connection.release).toHaveBeenCalledOnce();
    await mock.run();
    expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
  });

   it.each(["cancel:sub_fixture", "customer-delete:cus_fixture", "clerk-delete:user_fixture"])(
    "safely resumes after database commit and a failed %s", async failure => {
      const mock = membershipCleanupMocks();
      const before = protectedRecords(mock);
      mock.failOnce(failure);
      await expect(mock.run()).rejects.toThrow(`Injected ${failure} failure`);
      expect(mock.state.members.map(row => row.clerk_id)).toEqual(["user_member"]);
      expect(mock.state.checkouts.map(row => row.clerk_id)).toEqual(["user_member"]);
      expect(mock.state.identities.some(row => row.id === "user_fixture")).toBe(true);
      expect(mock.events).toContain("COMMIT");
      expect(mock.events).not.toContain("ROLLBACK");
      expect(mock.connection.release).toHaveBeenCalledOnce();
      expect(mock.pool.end).toHaveBeenCalledOnce();
      expect(protectedRecords(mock)).toEqual(before);
      await mock.run();
      expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
      expect(mock.state.customers.map(row => row.id)).toEqual(["cus_member"]);
      expect(mock.state.products[0].active).toBe(false);
      expect(mock.state.prices[0].active).toBe(false);
      expect(mock.stripe.subscriptions.cancel).toHaveBeenCalledTimes(failure.startsWith("cancel:") ? 2 : 1);
      expect(protectedRecords(mock)).toEqual(before);
      const after = mock.snapshot();
      mock.events.length = 0;
      await mock.run();
      expect(mock.snapshot()).toEqual(after);
      expect(mock.mutations()).toEqual([]);
    },
  );

  it("does not finish remote deletion on retry if the remaining identity was changed", async () => {
    const mock = membershipCleanupMocks();
    mock.failOnce("customer-delete:cus_fixture");
    await expect(mock.run()).rejects.toThrow(/Injected/);
    mock.identity.firstName = "Now in use";
    const before = mock.snapshot();
    mock.events.length = 0;
    await mock.run();
    expect(mock.snapshot()).toEqual(before);
    expect(mock.mutations()).toEqual([]);
  });

  it.each(["young", "unmarked", "changed", "extra-email"] as const)(
    "protects a run with a %s sibling while deleting an independent run", async kind => {
      const mock = membershipCleanupMocks();
      const sibling = mock.addFixture("abcdef123456", "b");
      const safe = mock.addFixture("123456abcdef");
      if (kind === "young") sibling.createdAt = Date.now();
      if (kind === "unmarked") sibling.privateMetadata = {};
      if (kind === "changed") sibling.firstName = "In use";
      if (kind === "extra-email") sibling.emailAddresses.push({ emailAddress: "another@example.com" });
      const before = mock.snapshot();
      const unrelated = protectedRecords(mock);
      await expect(mock.run()).rejects.toThrow(/Another identity in this run is not eligible/);
      expect(mock.state.identities).toEqual(before.identities.filter(row => row.id !== safe.id));
      expect(mock.state.members).toEqual(before.members.filter(row => row.clerk_id !== safe.id));
      expect(mock.state.checkouts).toEqual(before.checkouts.filter(row => row.clerk_id !== safe.id));
      expect(mock.state.customers).toEqual(before.customers.filter(row => row.email !== safe.emailAddresses[0].emailAddress));
      expect(mock.state.products[0]).toEqual(before.products[0]);
      expect(mock.state.prices[0]).toEqual(before.prices[0]);
      expect(mock.state.subscriptions.slice(0, 3)).toEqual(before.subscriptions.slice(0, 3));
      expect(mock.state.products.find(row => row.id === "prod_123456abcdef")?.active).toBe(false);
      expect(protectedRecords(mock)).toEqual(unrelated);
      expect(mock.pool.end).toHaveBeenCalledOnce();
    },
  );

  it.each(["identity", "billing", "database", "cancel", "customer", "clerk"] as const)(
    "continues independent cleanup after a sibling %s failure and preserves the shared catalog", async kind => {
      const mock = membershipCleanupMocks();
      const sibling = mock.addFixture("abcdef123456", "b");
      const safe = mock.addFixture("123456abcdef");
      const before = mock.snapshot();
      const unrelated = protectedRecords(mock);
      const failures = {
        identity: `clerk-get:${sibling.id}`,
        billing: `customer-list:${sibling.emailAddresses[0].emailAddress}`,
        cancel: "cancel:sub_abcdef123456_b",
        customer: "customer-delete:cus_abcdef123456_b",
        clerk: `clerk-delete:${sibling.id}`,
      };
      if (kind === "database") mock.state.members.find(row => row.clerk_id === sibling.id)!.bio = "Protected";
      else mock.failOnce(failures[kind]);
      await expect(mock.run()).rejects.toThrow(kind === "database" ? /Non-fixture/ : /Injected/);
      expect(mock.state.identities.some(row => row.id === sibling.id)).toBe(true);
      expect(mock.state.identities.some(row => row.id === safe.id)).toBe(false);
      expect(mock.state.products[0]).toEqual(before.products[0]);
      expect(mock.state.prices[0]).toEqual(before.prices[0]);
      expect(mock.stripe.products.update).not.toHaveBeenCalledWith("prod_fixture", { active: false });
      expect(mock.stripe.prices.update).not.toHaveBeenCalledWith("price_fixture", { active: false });
      if (["identity", "billing", "database"].includes(kind)) {
        expect(mock.state.customers.find(row => row.id === "cus_abcdef123456_b"))
          .toEqual(before.customers.find(row => row.id === "cus_abcdef123456_b"));
        expect(mock.state.subscriptions.find(row => row.id === "sub_abcdef123456_b"))
          .toEqual(before.subscriptions.find(row => row.id === "sub_abcdef123456_b"));
        expect(mock.state.checkouts.find(row => row.clerk_id === sibling.id))
          .toEqual(before.checkouts.find(row => row.clerk_id === sibling.id));
      }
      expect(protectedRecords(mock)).toEqual(unrelated);
      expect(mock.pool.end).toHaveBeenCalledOnce();
      expect(mock.connection.release).toHaveBeenCalledTimes(mock.pool.connect.mock.calls.length);
    },
  );

  it.each(["cancel:sub_fixture", "DELETE FROM users WHERE clerk_id = $1 AND email = $2"])(
    "skips a failed run's later sibling after %s but still cleans another run", async failure => {
    const mock = membershipCleanupMocks();
    const sibling = mock.addFixture("abcdef123456", "b");
    const safe = mock.addFixture("123456abcdef");
    const before = mock.snapshot();
    mock.failOnce(failure);
    await expect(mock.run()).rejects.toThrow(/Injected[\s\S]*user_abcdef123456_b/);
    expect(mock.clerk.users.getUser).not.toHaveBeenCalledWith(sibling.id);
    expect(mock.state.members.find(row => row.clerk_id === sibling.id))
      .toEqual(before.members.find(row => row.clerk_id === sibling.id));
    expect(mock.state.customers.find(row => row.id === "cus_abcdef123456_b"))
      .toEqual(before.customers.find(row => row.id === "cus_abcdef123456_b"));
    expect(mock.state.subscriptions.find(row => row.id === "sub_abcdef123456_b"))
      .toEqual(before.subscriptions.find(row => row.id === "sub_abcdef123456_b"));
    expect(mock.state.products[0]).toEqual(before.products[0]);
    expect(mock.state.prices[0]).toEqual(before.prices[0]);
    expect(mock.state.identities.some(row => row.id === safe.id)).toBe(false);
    expect(mock.connection.release).toHaveBeenCalledTimes(mock.pool.connect.mock.calls.length);
    if (failure.startsWith("DELETE")) {
      expect(mock.events).toContain("ROLLBACK");
      expect(mock.state.members.find(row => row.clerk_id === "user_fixture")).toEqual(before.members[0]);
      expect(mock.state.checkouts.find(row => row.clerk_id === "user_fixture")).toEqual(before.checkouts[0]);
    }
  });

  it("does not process any run when discovery cannot establish the complete sibling list", async () => {
    const mock = membershipCleanupMocks();
    mock.addFixture("123456abcdef");
    const before = mock.snapshot();
    mock.clerk.users.getUserList.mockRejectedValue(new Error("Clerk listing unavailable"));
    await expect(mock.run()).rejects.toThrow("Clerk listing unavailable");
    expect(mock.snapshot()).toEqual(before);
    expect(mock.mutations()).toEqual([]);
    expect(mock.pool.connect).not.toHaveBeenCalled();
    expect(mock.pool.end).toHaveBeenCalledOnce();
  });

  it("archives a successful sibling catalog only once, after both identities are deleted", async () => {
    const mock = membershipCleanupMocks();
    const sibling = mock.addFixture("abcdef123456", "b");
    await mock.run();
    expect(mock.events.indexOf(`clerk-delete:${sibling.id}`))
      .toBeLessThan(mock.events.indexOf("price-archive:price_fixture"));
    expect(mock.stripe.prices.update).toHaveBeenCalledExactlyOnceWith("price_fixture", { active: false });
    expect(mock.stripe.products.update).toHaveBeenCalledExactlyOnceWith("prod_fixture", { active: false });
    expect(mock.state.identities.map(row => row.id)).toEqual(["user_member"]);
  });

  it.each(["clerk-delete:user_fixture", "price-archive:price_fixture"])(
    "preserves a catalog repurposed after %s", async boundary => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      mock.afterOnce(boundary, () => { Object.assign(mock.state.products[0], { metadata: { owner: "real-member" } }); });
      await expect(mock.run()).rejects.toThrow(/Catalog for run abcdef123456: Unowned Stripe catalog/);
      expect(mock.state.products[0].active).toBe(true);
      expect(mock.state.products[0].metadata).toEqual({ owner: "real-member" });
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      expect(mock.stripe.prices.update).toHaveBeenCalledTimes(boundary.startsWith("price-archive") ? 1 : 0);
      expect(protectedRecords(mock)).toEqual(unrelated);
    },
  );

  it.each(["sibling", "other-billing", "extra-price", "renamed-product", "replacement-price"] as const)(
    "refuses catalog archival when %s appears after identity deletion", async kind => {
      const mock = membershipCleanupMocks();
      const unrelated = protectedRecords(mock);
      mock.afterOnce("clerk-delete:user_fixture", () => {
        if (kind === "sibling") mock.state.identities.push({
          ...structuredClone(mock.identity), id: "user_new", firstName: "Keep me",
          emailAddresses: [{ emailAddress: "membership-status-b-abcdef123456+clerk_test@example.com" }],
        });
        if (kind === "other-billing") mock.state.subscriptions.push({
          ...structuredClone(mock.state.subscriptions[1]), id: "sub_new",
          items: { data: [{ quantity: 1, price: structuredClone(mock.state.prices[0]) }] },
        });
        if (kind === "extra-price") mock.state.prices.push({ ...mock.state.prices[0], id: "price_new" });
        if (kind === "renamed-product") mock.state.products[0].name = "Real member catalog";
        if (kind === "replacement-price") mock.state.prices[0].id = "price_new";
      });
      await expect(mock.run()).rejects.toThrow(/Remaining identity|other billing|Additional test prices|catalog or billing changed/);
      expect(mock.state.products[0].active).toBe(true);
      expect(mock.state.prices[0].active).toBe(true);
      expect(mock.stripe.products.update).not.toHaveBeenCalled();
      expect(mock.stripe.prices.update).not.toHaveBeenCalled();
      expect(protectedRecords(mock)).toEqual(unrelated);
    },
  );

  it("keeps a product active if a new sibling appears during price archival", async () => {
    const mock = membershipCleanupMocks();
    mock.afterOnce("price-archive:price_fixture", () => mock.state.identities.push({
      ...structuredClone(mock.identity), id: "user_new",
      emailAddresses: [{ emailAddress: "membership-status-b-abcdef123456+clerk_test@example.com" }],
    }));
    await expect(mock.run()).rejects.toThrow(/Remaining identity in run/);
    expect(mock.state.identities.some(row => row.id === "user_new")).toBe(true);
    expect(mock.state.products[0].active).toBe(true);
    expect(mock.stripe.products.update).not.toHaveBeenCalled();
  });

  it("reports a catalog recheck outage without hiding it or archiving another account's catalog", async () => {
    const mock = membershipCleanupMocks();
    const independent = mock.addFixture("123456abcdef");
    mock.afterOnce(`clerk-delete:${independent.id}`, () => mock.failOnce("product-list"));
    await expect(mock.run()).rejects.toThrow(/Catalog for run abcdef123456: Injected product-list failure/);
    expect(mock.state.products[0].active).toBe(true);
    expect(mock.state.prices[0].active).toBe(true);
    expect(mock.state.products.find(row => row.id === "prod_123456abcdef")?.active).toBe(false);
  });

  it.each([{ args: [] }, { args: ["--delete"] }])("reports every blocked run in mode $args and still processes a safe run", async ({ args }) => {
    const mock = membershipCleanupMocks();
    const second = mock.addFixture("111111111111");
    const safe = mock.addFixture("222222222222");
    mock.state.members[0].bio = "Protected first";
    mock.state.invoices.find(row => row.customer === "cus_111111111111_a")!.total = 3000;
    const before = mock.snapshot();
    let error: unknown;
    try { await mock.run(args); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as Error).message).toContain("user_fixture");
    expect((error as Error).message).toContain(second.id);
    expect((error as Error).message).toContain("Non-fixture");
    expect((error as Error).message).toContain("Additional billing");
    expect(mock.state.members[0]).toEqual(before.members[0]);
    expect(mock.state.identities.some(row => row.id === second.id)).toBe(true);
    if (args.length) expect(mock.state.identities.some(row => row.id === safe.id)).toBe(false);
    else {
      expect(mock.snapshot()).toEqual(before);
      expect(mock.mutations()).toEqual([]);
      expect(mock.log).toHaveBeenCalledWith(expect.stringContaining(safe.id));
    }
    expect(mock.pool.end).toHaveBeenCalledOnce();
  });

  it.each(["price-archive:price_fixture", "product-archive:prod_fixture"])(
    "reports a catalog %s failure without blocking another run's catalog", async failure => {
      const mock = membershipCleanupMocks();
      mock.addFixture("123456abcdef");
      mock.failOnce(failure);
      await expect(mock.run()).rejects.toThrow(`Catalog for run abcdef123456: Injected ${failure} failure`);
      expect(mock.state.products.find(row => row.id === "prod_123456abcdef")?.active).toBe(false);
      expect(mock.state.prices.find(row => row.id === "price_123456abcdef")?.active).toBe(false);
      expect(mock.pool.end).toHaveBeenCalledOnce();
    },
  );

  it("refuses invalid command arguments and a failed development guard before inspecting resources", async () => {
    const mock = membershipCleanupMocks();
    await expect(mock.run(["--force"])).rejects.toThrow(/Usage:/);
    mock.requireDevelopment.mockImplementation(() => { throw new Error("Not a development target"); });
    await expect(mock.run()).rejects.toThrow(/Not a development target/);
    expect(mock.clerk.users.getUserList).not.toHaveBeenCalled();
    expect(mock.pool.connect).not.toHaveBeenCalled();
    expect(mock.mutations()).toEqual([]);
  });
});