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
      "price-archive:price_fixture", "product-archive:prod_fixture", "clerk-delete:user_fixture",
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
    expect(mock.clerk.users.getUserList.mock.calls).toEqual([
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

  it.each(["cancel:sub_fixture", "customer-delete:cus_fixture", "price-archive:price_fixture",
    "product-archive:prod_fixture", "clerk-delete:user_fixture"])(
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