import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type Stripe from "stripe";

const { checkout, otherCheckout, pendingCheckout, retrieveSubscription, queries } = vi.hoisted(() => ({
  checkout: {
    clerkId: "status-test-member",
    kind: "standard",
    status: "confirmed",
    stripeSubscriptionId: "sub_status_test",
    membershipTier: "Elevated",
  },
  otherCheckout: {
    clerkId: "status-test-other-member",
    kind: "founding",
    status: "confirmed",
    stripeSubscriptionId: "sub_status_other",
  },
  pendingCheckout: {
    clerkId: "status-test-pending-member",
    kind: "founding",
    status: "pending",
    stripeSubscriptionId: null,
  },
  retrieveSubscription: vi.fn(),
  queries: [] as string[],
}));

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
}));

// Keep the real requireAuth middleware; only skip account creation, which is
// unrelated to reading an existing member's subscription.
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  jitProvisionUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("@workspace/db", () => {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("WHERE stripe_subscription_id = $1 FOR UPDATE")) {
        expect(params).toEqual([checkout.stripeSubscriptionId]);
        return { rows: [{ id: "1", clerk_id: checkout.clerkId, kind: checkout.kind, status: checkout.status }] };
      }
      if (sql.startsWith("UPDATE membership_checkouts SET status = 'forfeited'")) {
        expect(params?.[0]).toBe("1");
        checkout.status = "forfeited";
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE users SET membership_tier = 'Free'")) {
        expect(params).toEqual([checkout.clerkId]);
        checkout.membershipTier = "Free";
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM membership_reconciliation_failures")) {
        expect(params).toEqual([checkout.stripeSubscriptionId]);
        return { rows: [] };
      }
      throw new Error(`Unexpected reconciliation query: ${sql}`);
    },
    release: vi.fn(),
  };
  return {
    db: {},
    usersTable: {},
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (!sql.includes("FROM membership_checkouts WHERE clerk_id = $1")) throw new Error(`Unexpected route query: ${sql}`);
        expect(params).toHaveLength(1);
        const record = [checkout, otherCheckout, pendingCheckout].find(member => member.clerkId === params?.[0]);
        return { rows: record ? [{
          kind: record.kind,
          status: record.status,
          stripe_subscription_id: record.stripeSubscriptionId,
        }] : [] };
      },
      connect: async () => client,
    },
  };
});

vi.mock("../lib/stripeClient", () => ({
  getUncachableStripeClient: async () => ({ subscriptions: { retrieve: retrieveSubscription } }),
}));

let server: Server;
let baseUrl: string;

async function status(user?: string) {
  const response = await fetch(`${baseUrl}/membership/me`, {
    headers: user ? { "x-test-user": user } : {},
  });
  return { code: response.status, body: await response.json() };
}

beforeAll(async () => {
  const { default: router } = await import("./membership");
  const app = express();
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  checkout.status = "confirmed";
  checkout.membershipTier = "Elevated";
  retrieveSubscription.mockReset();
  queries.length = 0;
});

test("authenticated membership status follows a scheduled cancellation, a portal resume, and an ended subscription", async () => {
  expect(await status()).toEqual({ code: 401, body: { error: "Unauthorized" } });
  expect(retrieveSubscription).not.toHaveBeenCalled();

  const periodEnd = Date.parse("2099-06-15T12:00:00Z") / 1000;
  const explicitEnd = Date.parse("2099-06-14T12:00:00Z") / 1000;
  const subscription = (changes: Partial<Stripe.Subscription>): Stripe.Subscription => ({
    id: checkout.stripeSubscriptionId,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: periodEnd }] },
    ...changes,
  } as Stripe.Subscription);

  // An explicit Stripe date wins over the item's period end.
  retrieveSubscription.mockResolvedValueOnce(subscription({ cancel_at: explicitEnd, cancel_at_period_end: true }));
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "confirmed", cancellationDate: "2099-06-14T12:00:00.000Z" } },
  });
  // Stripe may instead only supply the subscription item's period end.
  retrieveSubscription.mockResolvedValueOnce(subscription({ cancel_at_period_end: true }));
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "confirmed", cancellationDate: "2099-06-15T12:00:00.000Z" } },
  });
  expect(checkout.status).toBe("confirmed");
  expect(checkout.membershipTier).toBe("Elevated");
  expect(queries.some(sql => sql.startsWith("UPDATE"))).toBe(false);

  // Returning from the billing portal after resuming must not reuse the
  // cancellation date from the previous request.
  retrieveSubscription.mockResolvedValueOnce(subscription({}));
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "confirmed", cancellationDate: null } },
  });
  expect(checkout.status).toBe("confirmed");
  expect(queries.some(sql => sql.startsWith("UPDATE"))).toBe(false);

  retrieveSubscription.mockResolvedValueOnce(subscription({ status: "canceled" }))
    .mockResolvedValueOnce(subscription({ status: "canceled" }));
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "forfeited", cancellationDate: null } },
  });
  expect(retrieveSubscription).toHaveBeenCalledTimes(5);
  expect(retrieveSubscription).toHaveBeenCalledWith(checkout.stripeSubscriptionId);
  expect(checkout.status).toBe("forfeited");
  expect(checkout.membershipTier).toBe("Free");
  expect(queries.filter(sql => sql.startsWith("UPDATE membership_checkouts SET status"))).toHaveLength(1);
  // Once reconciled, the DB status is returned without a new Stripe lookup.
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "forfeited", cancellationDate: null } },
  });
  expect(retrieveSubscription).toHaveBeenCalledTimes(5);
});

test("membership status and cancellation date stay scoped to the signed-in member", async () => {
  const stripeCalls = retrieveSubscription.mock.calls.length;
  expect(await status()).toEqual({ code: 401, body: { error: "Unauthorized" } });
  expect(retrieveSubscription).toHaveBeenCalledTimes(stripeCalls);

  const scheduledEnd = Date.parse("2099-08-20T12:00:00Z") / 1000;
  const otherEnd = Date.parse("2099-09-12T12:00:00Z") / 1000;
  retrieveSubscription.mockImplementation(async (id: string) => {
    const end = id === checkout.stripeSubscriptionId ? scheduledEnd
      : id === otherCheckout.stripeSubscriptionId ? otherEnd : null;
    if (end === null) throw new Error(`Unexpected subscription: ${id}`);
    return {
      id, status: "active", cancel_at: end, cancel_at_period_end: true,
      items: { data: [{ current_period_end: end }] },
    } as Stripe.Subscription;
  });

  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "confirmed", cancellationDate: "2099-08-20T12:00:00.000Z" } },
  });
  expect(await status(otherCheckout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "founding", status: "confirmed", cancellationDate: "2099-09-12T12:00:00.000Z" } },
  });
  expect(await status(pendingCheckout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "founding", status: "pending", cancellationDate: null } },
  });
  // Returning to the first account must still read its own checkout.
  expect(await status(checkout.clerkId)).toEqual({
    code: 200,
    body: { membership: { kind: "standard", status: "confirmed", cancellationDate: "2099-08-20T12:00:00.000Z" } },
  });
  expect(retrieveSubscription).toHaveBeenCalledTimes(stripeCalls + 3);
  expect(retrieveSubscription.mock.calls.slice(stripeCalls).map(([id]) => id))
    .toEqual([checkout.stripeSubscriptionId, otherCheckout.stripeSubscriptionId, checkout.stripeSubscriptionId]);
  expect(retrieveSubscription).toHaveBeenLastCalledWith(checkout.stripeSubscriptionId);
});