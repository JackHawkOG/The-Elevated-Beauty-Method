// From the workspace root: pnpm run cleanup:membership-status-fixtures [--delete]
// Dry run by default. Only marked identities older than 24 hours are eligible.
import { createClerkClient } from "@clerk/backend";
import type Stripe from "stripe";
import type { PoolClient } from "../../../lib/db/src/index";
import { getTestStripeClient } from "../../../scripts/src/stripeClient";
import {
  fixtureRows, staleMembershipStatusFixture,
} from "./membership-status-fixtures";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";

type Fixture = NonNullable<ReturnType<typeof staleMembershipStatusFixture>>;

async function billingFor(stripe: Stripe, fixture: Fixture, createdAt: number) {
  const products: Stripe.Product[] = [];
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.name === `Disposable membership privacy check ${fixture.tag}`) products.push(product);
  }
  if (products.length > 1) throw new Error(`Ambiguous test product for ${fixture.email}`);
  const product = products[0];
  const prices: Stripe.Price[] = [];
  if (product) {
    for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) {
      prices.push(price);
      if (prices.length > 1) throw new Error(`Additional test prices for ${fixture.email}`);
    }
  }
  const price = prices[0];
  if (product && (Object.keys(product.metadata).length ||
      (price && (price.unit_amount !== 0 || price.currency !== "usd" ||
        price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
        Object.keys(price.metadata).length)))) {
    throw new Error(`Unowned Stripe catalog for ${fixture.email}`);
  }
  const customers = await stripe.customers.list({ email: fixture.email, limit: 100 });
  if (customers.has_more || customers.data.length > 1) throw new Error(`Ambiguous test customers for ${fixture.email}`);
  const customer = customers.data[0];
  if (!customer) return { customer: undefined, subscription: undefined, product, price };
  if (!product || !price ||
      customer.deleted || customer.email !== fixture.email || customer.address || customer.shipping ||
      Object.keys(customer.metadata).length || customer.name || customer.description ||
      customer.balance !== 0 || customer.invoice_settings.default_payment_method ||
      customer.created * 1000 < createdAt - 60_000) {
    throw new Error(`Unowned Stripe customer for ${fixture.email}`);
  }
  const subscriptions: Stripe.Subscription[] = [];
  for await (const subscription of stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 100 })) {
    subscriptions.push(subscription);
    if (subscriptions.length > 1) throw new Error(`Additional Stripe subscriptions for ${fixture.email}`);
  }
  const subscription = subscriptions[0];
  if (subscription) {
    const item = subscription.items.data[0];
    const price = item?.price;
    const product = price?.product;
    const expectedCancel = subscription.created + (fixture.role === "a" ? 4 : 5) * 86400;
    if (subscription.customer !== customer.id || subscription.items.data.length !== 1 ||
        item.quantity !== 1 || Object.keys(subscription.metadata).length ||
        !["active", "canceled"].includes(subscription.status) ||
        price?.unit_amount !== 0 || price.currency !== "usd" ||
        price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
        typeof product !== "string" || product !== products[0].id ||
        price.id !== prices[0].id ||
        // Stripe may clear cancel_at after executing a scheduled cancellation.
        (subscription.cancel_at !== null && Math.abs(subscription.cancel_at - expectedCancel) > 60) ||
        (subscription.cancel_at === null && subscription.status !== "canceled")) {
      throw new Error(`Unowned Stripe subscription for ${fixture.email}`);
    }
  }
  // A free test subscription can create $0 invoices, but must not carry any
  // chargeable history or a saved card. Never delete a customer with other billing.
  const [charges, cards, invoices] = await Promise.all([
    stripe.charges.list({ customer: customer.id, limit: 1 }),
    stripe.paymentMethods.list({ customer: customer.id, type: "card", limit: 1 }),
    stripe.invoices.list({ customer: customer.id, limit: 100 }),
  ]);
  if (charges.data.length || cards.data.length || invoices.has_more ||
      (invoices.data.length > 0 && !subscription) ||
      invoices.data.some(invoice => invoice.total !== 0 || invoice.amount_paid !== 0 ||
        invoice.parent?.type !== "subscription_details" ||
        (typeof invoice.parent.subscription_details?.subscription === "string"
          ? invoice.parent.subscription_details.subscription
          : invoice.parent.subscription_details?.subscription?.id) !== subscription?.id)) {
    throw new Error(`Additional billing records for ${fixture.email}`);
  }
  return { customer, subscription, product, price };
}

async function inspectRows(
  connection: PoolClient, clerkId: string, fixture: Fixture,
  subscriptionId: string | undefined, customerId: string | undefined,
) {
  const members = (await connection.query("SELECT * FROM users WHERE clerk_id = $1", [clerkId])).rows;
  const checkouts = (await connection.query("SELECT * FROM membership_checkouts WHERE clerk_id = $1", [clerkId])).rows;
  if (!fixtureRows(members, checkouts, fixture, subscriptionId)) {
    throw new Error(`Non-fixture member or membership data for ${clerkId}`);
  }
  // A checkout can belong to another account even when this identity's rows look valid.
  if (subscriptionId && (await connection.query(
    "SELECT id FROM membership_checkouts WHERE stripe_subscription_id = $1 AND clerk_id <> $2",
    [subscriptionId, clerkId],
  )).rowCount) throw new Error(`Subscription belongs to another member for ${clerkId}`);
  if (customerId && (await connection.query(
    "SELECT id FROM membership_checkouts WHERE stripe_customer_id = $1 AND clerk_id <> $2",
    [customerId, clerkId],
  )).rowCount) throw new Error(`Customer belongs to another member for ${clerkId}`);
  const linked = [
    ["enrollments", "user_id"], ["lesson_completions", "user_id"],
    ["announcements", "actor_id"], ["member_stories", "permission_recorded_by"],
    ["member_stories", "withdrawn_by"], ["member_stories", "removal_requested_by"],
    ["member_stories", "verified_subject_user_id"], ["member_stories", "subject_verified_by"],
    ["member_stories", "removal_reviewed_by"], ["member_story_review_corrections", "reviewed_by"],
    ["activity", "source_reviewed_by"],
    ["radiant_audits", "clerk_id"], ["radiant_audit_drafts", "clerk_id"],
    ["radiant_audit_history", "clerk_id"], ["radiant_audit_submissions", "clerk_id"],
  ] as const;
  for (const [table, column] of linked) {
    if ((await connection.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [clerkId])).rowCount) {
      throw new Error(`Related member data in ${table}; refusing deletion for ${clerkId}`);
    }
  }
  if (members.length && (await connection.query(
    "SELECT 1 FROM users WHERE email = $1 AND clerk_id <> $2 LIMIT 1", [fixture.email, clerkId],
  )).rowCount) throw new Error(`Email is shared by another member for ${clerkId}`);
  return { members: members.length, checkouts: checkouts.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:membership-status-fixtures [--delete]");
  }
  requireAuditDevelopment();
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const stripe = await getTestStripeClient();
  // Connect only after both the workspace DB guard and test-mode Stripe guard.
  const { pool } = await import("../../../lib/db/src/index");
  try {
    const candidates: Array<{ id: string; email: string }> = [];
    const blockedTags = new Set<string>();
    for (let offset = 0; ; offset += 100) {
      const page = await clerk.users.getUserList({ limit: 100, offset });
      for (const user of page.data) {
        const fixture = staleMembershipStatusFixture(user);
        if (fixture) candidates.push({ id: user.id, email: fixture.email });
        else {
          // A second identity from the same run may still be in use. In that
          // case even the old account's shared catalog must not be archived.
          const possible = user.emailAddresses.length === 1 &&
            /^membership-status-[ab]-([0-9a-f]{12})\+clerk_test@example\.com$/.exec(user.emailAddresses[0].emailAddress);
          if (possible) blockedTags.add(possible[1]);
        }
      }
      if (!page.data.length || offset + page.data.length >= page.totalCount) break;
    }
    for (const candidate of candidates) {
      requireAuditDevelopment();
      const identity = await clerk.users.getUser(candidate.id);
      const fixture = staleMembershipStatusFixture(identity);
      if (!fixture || fixture.email !== candidate.email) {
        throw new Error(`Fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      if (blockedTags.has(fixture.tag)) {
        throw new Error(`Another identity in this run is not eligible; refusing ${fixture.tag}`);
      }
      const { customer, subscription, product, price } = await billingFor(stripe, fixture, identity.createdAt);
      const connection = await pool.connect();
      let counts: { members: number; checkouts: number };
      try {
        await connection.query("BEGIN");
        // Lock the member, and reject all unexpected links before modifying anything.
        await connection.query("SELECT id FROM users WHERE clerk_id = $1 FOR UPDATE", [candidate.id]);
        counts = await inspectRows(connection, candidate.id, fixture, subscription?.id, customer?.id);
        if (args.length) {
          // Recheck Clerk immediately before deletion. If later remote cleanup fails,
          // the marked identity remains available for a safe retry.
          const latest = await clerk.users.getUser(candidate.id);
          if (!staleMembershipStatusFixture(latest) || latest.emailAddresses[0].emailAddress !== fixture.email) {
            throw new Error(`Fixture identity changed; refusing deletion for ${candidate.id}`);
          }
          await connection.query("DELETE FROM membership_checkouts WHERE clerk_id = $1", [candidate.id]);
          await connection.query("DELETE FROM users WHERE clerk_id = $1 AND email = $2", [candidate.id, fixture.email]);
        }
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      console.log(`${args.length ? "Removing" : "Would remove"} ${candidate.id} (${fixture.email}): ${counts.members} member, ${counts.checkouts} checkout, ${subscription ? 1 : 0} subscription, ${customer ? 1 : 0} customer`);
      if (args.length) {
        if (subscription && subscription.status !== "canceled") await stripe.subscriptions.cancel(subscription.id);
        if (customer) await stripe.customers.del(customer.id);
        // Archiving is idempotent, including when a previous run stopped between
        // the database commit and removal of the marked Clerk identity.
        if (price?.active) await stripe.prices.update(price.id, { active: false });
        if (product?.active) await stripe.products.update(product.id, { active: false });
        await clerk.users.deleteUser(candidate.id);
      }
    }
    if (!args.length) console.log("Dry run; nothing deleted. Pass --delete to remove eligible marked fixtures.");
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });