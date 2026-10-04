import { vi } from "vitest";
import { cleanupMembershipStatusFixtures } from "./membership-status-fixtures-cleanup";
import { membershipStatusFixtureMetadata, requireMembershipStatusDevelopment } from "./membership-status-fixtures";

const email = "membership-status-a-abcdef123456+clerk_test@example.com";
type Row = Record<string, unknown>;
type Identity = {
  id: string; emailAddresses: { emailAddress: string }[];
  privateMetadata: Record<string, unknown>; publicMetadata: Record<string, unknown>;
  firstName: string | null; lastName: string | null; createdAt: number;
};
export const relatedMemberColumns = [
  ["enrollments", "user_id"], ["lesson_completions", "user_id"],
  ["announcements", "actor_id"], ["member_stories", "permission_recorded_by"],
  ["member_stories", "withdrawn_by"], ["member_stories", "removal_requested_by"],
  ["member_stories", "verified_subject_user_id"], ["member_stories", "subject_verified_by"],
  ["member_stories", "removal_reviewed_by"], ["member_story_review_corrections", "reviewed_by"],
  ["activity", "source_reviewed_by"], ["radiant_audits", "clerk_id"],
  ["radiant_audit_drafts", "clerk_id"], ["radiant_audit_history", "clerk_id"],
  ["radiant_audit_submissions", "clerk_id"],
] as const;

// Stateful, disposable mocks. No imports of the live DB, no credentials, and
// unknown SQL is an error rather than an empty result that could hide a guard.
export function membershipCleanupMocks() {
  const createdAt = Date.now() - 25 * 60 * 60 * 1000;
  const identity: Identity = {
    id: "user_fixture", emailAddresses: [{ emailAddress: email }],
    privateMetadata: { ...membershipStatusFixtureMetadata }, publicMetadata: {},
    firstName: null, lastName: null, createdAt,
  };
  const otherIdentity: Identity = {
    ...structuredClone(identity), id: "user_member", privateMetadata: {},
    emailAddresses: [{ emailAddress: "member@example.com" }], firstName: "Member",
  };
  const state = {
    identities: [identity, otherIdentity],
    members: [
      { id: "user_fixture", clerk_id: identity.id, email, display_name: "New Learner",
        membership_tier: "Elevated", bio: null, avatar_url: null, skin_type: null,
        undertone: null, feature_needs: null, life_stage: null, visibility_goal: null },
      { id: "user_member", clerk_id: otherIdentity.id, email: "member@example.com",
        display_name: "Member", membership_tier: "Elevated", bio: "Keep me" },
    ] as Row[],
    checkouts: [
      { id: 1, clerk_id: identity.id, kind: "standard", status: "confirmed",
        stripe_subscription_id: "sub_fixture", stripe_customer_id: null,
        stripe_session_id: null, failed_months: 0, last_failed_invoice: null },
      { id: 2, clerk_id: otherIdentity.id, stripe_subscription_id: "sub_member",
        stripe_customer_id: "cus_member", kind: "founding", status: "confirmed" },
    ] as Row[],
    related: Object.fromEntries(relatedMemberColumns.map(([table]) =>
      [table, [{ clerk_id: otherIdentity.id, user_id: otherIdentity.id }]])) as Record<string, Row[]>,
    products: [
      { id: "prod_fixture", name: "Disposable membership privacy check abcdef123456", metadata: {}, active: true },
      { id: "prod_member", name: "Real membership", metadata: {}, active: true },
    ],
    prices: [
      { id: "price_fixture", product: "prod_fixture", unit_amount: 0, currency: "usd",
        recurring: { interval: "month", interval_count: 1 }, metadata: {}, active: true },
      { id: "price_member", product: "prod_member", unit_amount: 2500, currency: "usd",
        recurring: { interval: "month", interval_count: 1 }, metadata: {}, active: true },
    ],
    customers: [
      { id: "cus_fixture", email, address: null, shipping: null, metadata: {}, name: null,
        description: null, balance: 0, invoice_settings: { default_payment_method: null },
        created: Math.floor(createdAt / 1000) },
      { id: "cus_member", email: "member@example.com", address: null, shipping: null,
        metadata: {}, name: null, description: null, balance: 0,
        invoice_settings: { default_payment_method: null }, created: Math.floor(createdAt / 1000) },
    ],
    subscriptions: [] as Array<{
      id: string; customer: string; status: string; created: number; cancel_at: number | null;
      metadata: Record<string, unknown>;
      items: { data: Array<{ quantity: number; price: {
        id: string; product: string; unit_amount: number; currency: string;
        recurring: { interval: string; interval_count: number }; metadata: Record<string, unknown>;
      } }> };
    }>,
    invoices: [
      { id: "in_fixture", customer: "cus_fixture", total: 0, amount_paid: 0,
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_fixture" } } },
      { id: "in_member", customer: "cus_member", total: 2500, amount_paid: 2500,
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_member" } } },
    ],
    charges: [] as Row[], cards: [] as Row[],
  };
  state.subscriptions = state.customers.map((customer, index) => ({
    id: index ? "sub_member" : "sub_fixture", customer: customer.id, status: "active",
    created: customer.created, cancel_at: customer.created + 4 * 86400, metadata: {},
    items: { data: [{ quantity: 1, price: structuredClone(state.prices[index]) }] },
  }));
  // Add independent runs or role-b siblings without ever using live providers.
  function addFixture(tag: string, role: "a" | "b" = "a") {
    const suffix = `${tag}_${role}`;
    const fixtureEmail = `membership-status-${role}-${tag}+clerk_test@example.com`;
    const added = {
      ...structuredClone(identity), id: `user_${suffix}`,
      emailAddresses: [{ emailAddress: fixtureEmail }],
    };
    state.identities.push(added);
    state.members.push({
      ...structuredClone(state.members[0]), id: added.id, clerk_id: added.id, email: fixtureEmail,
    });
    state.checkouts.push({
      ...structuredClone(state.checkouts[0]), id: state.checkouts.length + 1,
      clerk_id: added.id, kind: role === "a" ? "standard" : "founding",
      stripe_subscription_id: `sub_${suffix}`,
    });
    let product = state.products.find(row => row.name === `Disposable membership privacy check ${tag}`);
    if (!product) {
      product = { ...structuredClone(state.products[0]), id: `prod_${tag}`,
        name: `Disposable membership privacy check ${tag}` };
      state.products.push(product);
      state.prices.push({ ...structuredClone(state.prices[0]), id: `price_${tag}`, product: product.id });
    }
    const price = state.prices.find(row => row.product === product.id)!;
    state.customers.push({
      ...structuredClone(state.customers[0]), id: `cus_${suffix}`, email: fixtureEmail,
    });
    const subscription = {
      ...structuredClone(state.subscriptions[0]), id: `sub_${suffix}`, customer: `cus_${suffix}`,
      cancel_at: state.subscriptions[0].created + (role === "a" ? 4 : 5) * 86400,
      items: { data: [{ quantity: 1, price: structuredClone(price) }] },
    };
    state.subscriptions.push(subscription);
    state.invoices.push({
      ...structuredClone(state.invoices[0]), id: `in_${suffix}`, customer: `cus_${suffix}`,
      parent: { type: "subscription_details", subscription_details: { subscription: subscription.id } },
    });
    return added;
  }
  const events: string[] = [];
  let failure: string | undefined;
  function operation(name: string) {
    events.push(name);
    if (failure === name) { failure = undefined; throw new Error(`Injected ${name} failure`); }
  }
  const mutations = () => events.filter(event => event.startsWith("DELETE ") ||
    /^(cancel|customer-delete|price-archive|product-archive|clerk-delete):/.test(event));
  const snapshot = () => structuredClone(state);
  let transaction: Pick<typeof state, "members" | "checkouts"> | undefined;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    operation(sql);
    let rows: Row[] = [];
    if (sql === "BEGIN") {
      transaction = structuredClone({ members: state.members, checkouts: state.checkouts });
    } else if (sql === "COMMIT") {
      transaction = undefined;
    } else if (sql === "ROLLBACK") {
      if (transaction) Object.assign(state, transaction);
      transaction = undefined;
    } else if (sql === "SELECT * FROM users WHERE clerk_id = $1" ||
      sql === "SELECT id FROM users WHERE clerk_id = $1 FOR UPDATE") {
      rows = state.members.filter(row => row.clerk_id === values[0]);
    } else if (sql === "SELECT * FROM membership_checkouts WHERE clerk_id = $1") {
      rows = state.checkouts.filter(row => row.clerk_id === values[0]);
    } else if (/^SELECT id FROM membership_checkouts WHERE stripe_(subscription|customer)_id = \$1 AND clerk_id <> \$2$/.test(sql)) {
      const column = sql.includes("stripe_subscription") ? "stripe_subscription_id" : "stripe_customer_id";
      rows = state.checkouts.filter(row => row[column] === values[0] && row.clerk_id !== values[1]);
    } else if (sql === "SELECT 1 FROM users WHERE email = $1 AND clerk_id <> $2 LIMIT 1") {
      rows = state.members.filter(row => row.email === values[0] && row.clerk_id !== values[1]);
    } else if (sql === "DELETE FROM membership_checkouts WHERE clerk_id = $1") {
      state.checkouts = state.checkouts.filter(row => row.clerk_id !== values[0]);
    } else if (sql === "DELETE FROM users WHERE clerk_id = $1 AND email = $2") {
      state.members = state.members.filter(row => row.clerk_id !== values[0] || row.email !== values[1]);
    } else {
      const match = /^SELECT 1 FROM (\w+) WHERE (\w+) = \$1 LIMIT 1$/.exec(sql);
      if (!match || !relatedMemberColumns.some(([table, column]) => table === match[1] && column === match[2])) {
        throw new Error(`Unhandled mock SQL: ${sql}`);
      }
      rows = state.related[match[1]].filter(row => row[match[2]] === values[0]);
    }
    return { rows: structuredClone(rows), rowCount: rows.length };
  });
  const connection = { query, release: vi.fn(() => events.push("release")) };
  const pool = { connect: vi.fn(async () => connection), end: vi.fn(async () => { events.push("pool-end"); }) };
  const clerk = { users: {
    getUserList: vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
      data: structuredClone(state.identities.slice(offset, offset + limit)), totalCount: state.identities.length,
    })),
    getUser: vi.fn(async (id: string) => {
      operation(`clerk-get:${id}`);
      const user = state.identities.find(user => user.id === id);
      if (!user) throw new Error(`Missing mock Clerk user ${id}`);
      return structuredClone(user);
    }),
    deleteUser: vi.fn(async (id: string) => {
      operation(`clerk-delete:${id}`);
      state.identities = state.identities.filter(user => user.id !== id);
    }),
  } };
  async function* iterate<T>(rows: T[]) { yield* structuredClone(rows); }
  const stripe = {
    products: {
      list: vi.fn(() => iterate(state.products)),
      retrieve: vi.fn(async (id: string) => structuredClone(state.products.find(row => row.id === id))),
      update: vi.fn(async (id: string, patch: { active: boolean }) => {
        operation(`product-archive:${id}`); Object.assign(state.products.find(row => row.id === id)!, patch);
      }),
    },
    prices: {
      list: vi.fn(({ product }: { product: string }) => iterate(state.prices.filter(row => row.product === product))),
      update: vi.fn(async (id: string, patch: { active: boolean }) => {
        operation(`price-archive:${id}`); Object.assign(state.prices.find(row => row.id === id)!, patch);
      }),
    },
    customers: {
      list: vi.fn(async ({ email }: { email: string }) => {
        operation(`customer-list:${email}`);
        return { data: structuredClone(state.customers.filter(row => row.email === email)), has_more: false };
      }),
      del: vi.fn(async (id: string) => {
        operation(`customer-delete:${id}`); state.customers = state.customers.filter(row => row.id !== id);
      }),
    },
    subscriptions: {
      list: vi.fn(({ customer }: { customer: string }) => iterate(state.subscriptions.filter(row => row.customer === customer))),
      cancel: vi.fn(async (id: string) => {
        operation(`cancel:${id}`);
        const subscription = state.subscriptions.find(row => row.id === id)!;
        subscription.status = "canceled"; subscription.cancel_at = null;
      }),
    },
    invoices: { list: vi.fn(async ({ customer }: { customer: string }) => ({
      data: structuredClone(state.invoices.filter(row => row.customer === customer)), has_more: false,
    })) },
    charges: { list: vi.fn(async ({ customer }: { customer: string }) => ({
      data: structuredClone(state.charges.filter(row => row.customer === customer)),
    })) },
    paymentMethods: { list: vi.fn(async ({ customer }: { customer: string }) => ({
      data: structuredClone(state.cards.filter(row => row.customer === customer)),
    })) },
  };
  const requireDevelopment = vi.fn(() => requireMembershipStatusDevelopment({
    CLERK_SECRET_KEY: "sk_test_mock", CLERK_PUBLISHABLE_KEY: "pk_test_mock",
    REPLIT_DEV_DOMAIN: "mock.replit.dev", PGHOST: "mock.db", PGPORT: "5432",
    PGDATABASE: "mock", PGUSER: "mock",
    DATABASE_URL: "postgresql://mock:fake@mock.db:5432/mock",
  }));
  // Cast only at the SDK boundary: these mocks intentionally implement just
  // the methods used by the real runner, not entire remote SDKs or a PG server.
  const dependencies = { clerk, stripe, pool, requireDevelopment, log: vi.fn() } as unknown as
    Parameters<typeof cleanupMembershipStatusFixtures>[0];
  return {
    state, identity, clerk, stripe, pool, connection, events, mutations, snapshot, requireDevelopment, addFixture,
    log: dependencies.log,
    failOnce: (name: string) => { failure = name; },
    run: (args: string[] = ["--delete"]) => cleanupMembershipStatusFixtures(dependencies, args),
  };
}