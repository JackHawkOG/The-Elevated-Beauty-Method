import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
import { FOUNDING_LIMIT } from "../lib/membership-reservations";
import { logger } from "../lib/logger";
import { requireDevelopmentDatabase } from "./test-development-database";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = req.header("x-test-user");
    next();
  },
  jitProvisionUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
import { recoverQueuedCheckoutExpirations } from "../lib/membership-checkout-expirations";
import { expireUntrackedMembershipSessions } from "../lib/membership-orphan-recovery";
import { reconcileUntrackedPaidSessions } from "../lib/membership-paid-recovery";

type TestSession = {
  id: string; status: string; url: string; created: number;
  metadata?: { reservationId: string; membershipCheckout?: string };
  payment_status?: string; subscription?: string;
  mode?: string; customer?: string; client_reference_id?: string; priceId?: string;
};
const sessions = new Map<string, TestSession>();
const customers = new Map<string, { metadata: { clerkId: string }; deleted: false }>();
const createSession = vi.fn(async (params?: { metadata?: TestSession["metadata"]; customer?: string; client_reference_id?: string; mode?: string; line_items?: Array<{ price: string }> }, options?: { idempotencyKey?: string }) => {
  const id = `cs_${randomUUID()}`;
  const session: TestSession = { id, status: "open", url: `https://checkout.stripe.test/${id}`,
    created: Math.floor(Date.now() / 1000), metadata: params?.metadata, customer: params?.customer,
    client_reference_id: params?.client_reference_id, mode: params?.mode, priceId: params?.line_items?.[0]?.price };
  sessions.set(id, session);
  return session;
});

const listSessions = vi.fn(async (params: { status: string; created: { lte?: number; gte?: number }; limit: number; starting_after?: string }) => {
  const eligible = [...sessions.values()].filter(s => s.status === params.status
    && (params.created.lte === undefined || s.created <= params.created.lte)
    && (params.created.gte === undefined || s.created >= params.created.gte));
  const offset = params.starting_after ? eligible.findIndex(s => s.id === params.starting_after) + 1 : 0;
  return { data: eligible.slice(offset, offset + params.limit), has_more: offset + params.limit < eligible.length };
});
const retrieveSession = vi.fn(async (id: string) => {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown test session: ${id}`);
  return session;
});
const expireSession = vi.fn(async (id: string) => {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown test session: ${id}`);
  if (session.status !== "open") throw new Error(`Session is not open: ${id}`);
  session.status = "expired";
  session.url = "";
  return session;
});
const processWebhook = vi.fn(async () => {});
const invoiceHistory: Array<{ id: string; created: number; status: string; attempt_count: number; billing_reason: string }> = [];
let subscriptionStatus = "active";
const cancelSubscription = vi.fn(async (id: string) => {
  subscriptionStatus = "canceled";
  return { id, status: subscriptionStatus, cancel_at: null, cancel_at_period_end: false, items: { data: [] } };
});
vi.mock("../lib/stripeClient", () => ({
  getUncachableStripeClient: async () => ({
    prices: { list: async () => ({ data: [
       { id: "price_founder_test", lookup_key: "founding_2026", unit_amount: 2400, currency: "usd", recurring: { interval: "month" } },
       { id: "price_standard_test", lookup_key: "standard_2026", unit_amount: 4800, currency: "usd", recurring: { interval: "month" } },
    ] }) },
    customers: {
      create: async (params: { metadata: { clerkId: string } }) => {
        const id = `cus_${randomUUID()}`;
        customers.set(id, { metadata: params.metadata, deleted: false });
        return { id };
      },
      retrieve: async (id: string) => customers.get(id) ?? { deleted: true },
    },
    checkout: { sessions: {
      create: createSession, list: listSessions, retrieve: retrieveSession, expire: expireSession,
      listLineItems: async (id: string) => ({ data: [{ quantity: 1, price: { id: sessions.get(id)?.priceId } }], has_more: false }),
    } },
    invoices: { list: async () => ({ data: [...invoiceHistory].sort((a, b) => b.created - a.created), has_more: false }) },
    subscriptions: {
      retrieve: async (id: string) => ({
        id, status: subscriptionStatus, cancel_at: null, cancel_at_period_end: false, items: { data: [] },
        customer: [...sessions.values()].find(session => session.subscription === id)?.customer,
        metadata: { reservationId: [...sessions.values()].find(session => session.subscription === id)?.metadata?.reservationId },
      }),
      cancel: cancelSubscription,
    },
  }),
  getStripeSync: async () => ({ processWebhook }),
}));

const prefix = `membership-flow-${randomUUID()}`;
const users: string[] = [];
const events: string[] = [];
let server: Server;
let baseUrl: string;
let fixtureLock: PoolClient | undefined;
let safeToCleanup = false;
const realNow = Date.now;
const opens = Date.parse("2026-10-01T14:00:00Z");
const closes = Date.parse("2026-10-08T05:00:00Z");

function clock(at: number) {
  vi.spyOn(Date, "now").mockReturnValue(at);
}

async function request(path: string, method = "GET", user?: string, body?: object) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(user ? { "x-test-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function webhook(type: string, object: object, id = `evt_${randomUUID()}`) {
  events.push(id);
  const response = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "test-signature" },
    body: JSON.stringify({ id, type, data: { object } }),
  });
  return response.status;
}

async function addUser(index: number) {
  const id = `${prefix}-${index}-${randomUUID()}`;
  users.push(id);
  await pool.query("INSERT INTO users (clerk_id, display_name, email) VALUES ($1, $1, $2)", [id, `${id}@example.invalid`]);
  return id;
}

async function row(id: string) {
  const result = await pool.query<{ status: string; stripe_session_id: string; failed_months: number; membership_tier: string }>(
    "SELECT m.status, m.stripe_session_id, m.failed_months, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.clerk_id = $1 ORDER BY m.id DESC LIMIT 1",
    [id],
  );
  return result.rows[0];
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  safeToCleanup = true;
  // Prevent separate Vitest processes from filling the same 50-place inventory.
  fixtureLock = await pool.connect();
  await fixtureLock.query("SELECT pg_advisory_lock(20261001, 55)");
  await ensureMembershipSchema();
  const { default: router, handleMembershipWebhook } = await import("./membership");
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  app.post("/webhook", express.raw({ type: "application/json" }), handleMembershipWebhook);
  app.use(express.json(), router);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.REPLIT_DOMAINS ||= "membership-test.example.invalid";
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (safeToCleanup && events.length) await pool.query("DELETE FROM membership_webhook_events WHERE id = ANY($1::text[])", [events]);
    if (safeToCleanup && users.length) {
      await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [users]);
      await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [users]);
    }
  } finally {
    if (fixtureLock) {
      await fixtureLock.query("SELECT pg_advisory_unlock(20261001, 55)");
      fixtureLock.release();
    }
    await pool.end();
  }
});

test("opening is inclusive and closing is exclusive for the offer and founding checkout", async () => {
  const buyer = await addUser(217);
  clock(opens - 1);
  expect((await request("/membership/offer")).data.phase).toBe("upcoming");
  expect((await request("/membership/checkout", "POST", buyer, { kind: "founding" })).status).toBe(409);
  clock(opens);
  expect((await request("/membership/offer")).data.phase).toBe("open");
  expect((await request("/membership/checkout", "POST", buyer, { kind: "founding" })).status).toBe(200);
  expect(await webhook("checkout.session.expired", {
    object: "checkout.session", id: (await row(buyer)).stripe_session_id,
  })).toBe(200);
  clock(closes - 1);
  expect((await request("/membership/offer")).data.phase).toBe("open");
  clock(closes);
  expect((await request("/membership/offer")).data.phase).toBe("closed");
  expect((await request("/membership/checkout", "POST", buyer, { kind: "founding" })).status).toBe(409);
  vi.restoreAllMocks();
});

test("a database failure after Stripe session creation expires the untracked checkout", async () => {
  clock(opens);
  const buyer = await addUser(217);
  const originalConnect = pool.connect.bind(pool);
  let restoreQuery: (() => void) | undefined;
  const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const querySpy = vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("UPDATE membership_checkouts SET stripe_session_id")) {
        return Promise.reject(new Error("Simulated reservation update failure"));
      }
      return (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    restoreQuery = () => querySpy.mockRestore();
    return client;
  });
  const creationsBefore = createSession.mock.results.length;
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request("/membership/checkout", "POST", buyer, { kind: "standard" });
  } finally {
    connectSpy.mockRestore();
    restoreQuery?.();
  }
  const session = [...sessions.values()].at(-1)!;
  expect(response.status).toBe(503);
  expect(response.data.url).toBeUndefined();
  expect(expireSession).toHaveBeenCalledWith(session.id);
  expect(sessions.get(session.id)).toMatchObject({ status: "expired", url: "" });
  expect(await row(buyer)).toBeUndefined();
  vi.restoreAllMocks();
});

test("failed Stripe cleanup is queued and retried without returning a checkout URL", async () => {
  clock(opens);
  const buyer = await addUser(217);
  const originalConnect = pool.connect.bind(pool);
  let restoreQuery: (() => void) | undefined;
  const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const querySpy = vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("UPDATE membership_checkouts SET stripe_session_id")) {
        return Promise.reject(new Error("Simulated reservation update failure"));
      }
      return (originalQuery as (...queryArgs: unknown[]) => unknown)(...args);
    }) as typeof client.query);
    restoreQuery = () => querySpy.mockRestore();
    return client;
  });
  const creationsBefore = createSession.mock.results.length;
  expireSession.mockRejectedValueOnce(new Error("Stripe temporarily unavailable"));
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request("/membership/checkout", "POST", buyer, { kind: "standard" });
  } finally {
    connectSpy.mockRestore();
    restoreQuery?.();
  }
  const session = [...sessions.values()].at(-1)!;
  const queued = async () => (await pool.query(
    "SELECT stripe_session_id FROM membership_checkout_expirations WHERE stripe_session_id = $1", [session.id],
  )).rows;
  expect(response.status).toBe(503);
  expect(response.data.url).toBeUndefined();
  expect(await row(buyer)).toBeUndefined();
  expect(sessions.get(session.id)?.status).toBe("open");
  expect(await queued()).toHaveLength(1);
  await recoverQueuedCheckoutExpirations();
  expect(sessions.get(session.id)).toMatchObject({ status: "expired", url: "" });
  expect(await queued()).toHaveLength(0);
  const expirations = expireSession.mock.calls.filter(([sessionId]) => sessionId === session.id).length;
  await recoverQueuedCheckoutExpirations();
  expect(expireSession.mock.calls.filter(([id]) => id === session.id)).toHaveLength(expirations);
  vi.restoreAllMocks();
});

test("recovery does not expire a checkout that completed while cleanup was unavailable", async () => {
  const id = `cs_${randomUUID()}`;
  sessions.set(id, { id, status: "complete", payment_status: "paid", url: "", created: Math.floor(Date.now() / 1000) });
  await pool.query("INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1)", [id]);
  const before = expireSession.mock.calls.length;
  await recoverQueuedCheckoutExpirations();
  expect(expireSession.mock.calls).toHaveLength(before);
  expect(sessions.get(id)?.status).toBe("complete");
  expect((await pool.query("SELECT 1 FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id])).rows).toHaveLength(0);
  sessions.delete(id);
});

test("recovery clears a paid checkout retry even when Stripe still marks it open", async () => {
  const id = `cs_${randomUUID()}`;
  const session: TestSession = { id, status: "open", payment_status: "paid", url: "https://checkout.stripe.test/paid",
    created: Math.floor(Date.now() / 1000) };
  sessions.set(id, session);
  await pool.query("INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1)", [id]);
  try {
    const expirationsBefore = expireSession.mock.calls.filter(([sessionId]) => sessionId === id).length;
    await recoverQueuedCheckoutExpirations();
    expect(expireSession.mock.calls.filter(([sessionId]) => sessionId === id)).toHaveLength(expirationsBefore);
    expect(session).toMatchObject({ id, status: "open", payment_status: "paid" });
    expect((await pool.query(
      "SELECT 1 FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id],
    )).rows).toHaveLength(0);
  } finally {
    await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id]);
    sessions.delete(id);
  }
});

test.each(["open", "complete"] as const)(
  "recovery retries a failed Stripe lookup and uses the live %s session status",
  async (status) => {
    const id = `cs_${randomUUID()}`;
    const session: TestSession = { id, status: "open", url: "https://checkout.stripe.test/retry",
      created: Math.floor(Date.now() / 1000) };
    sessions.set(id, session);
    await pool.query("INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1)", [id]);
    const originalRetrieve = retrieveSession.getMockImplementation()!;

    let failLookup = true;
    retrieveSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === id && failLookup) {
        failLookup = false;
        throw new Error("Stripe status lookup temporarily unavailable");
      }
      return originalRetrieve(sessionId);
    });
    const queued = async () => (await pool.query(
      "SELECT stripe_session_id FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id],
    )).rows;
    const retrievesBefore = retrieveSession.mock.calls.filter(([sessionId]) => sessionId === id).length;
    const expirationsBefore = expireSession.mock.calls.filter(([sessionId]) => sessionId === id).length;

    try {
      await recoverQueuedCheckoutExpirations();
      expect(retrieveSession.mock.calls.filter(([sessionId]) => sessionId === id)).toHaveLength(retrievesBefore + 1);
      expect(expireSession.mock.calls.filter(([sessionId]) => sessionId === id)).toHaveLength(expirationsBefore);
      expect(session.status).toBe("open");
      expect(await queued()).toHaveLength(1);

      if (status === "complete") {
        session.status = "complete";
        session.payment_status = "paid";
        session.url = "";
      }
      await recoverQueuedCheckoutExpirations();
      const retrievesAfterRetry = retrieveSession.mock.calls.filter(([sessionId]) => sessionId === id).length;
      expect(retrievesAfterRetry).toBeGreaterThanOrEqual(retrievesBefore + 2);
      expect(await queued()).toHaveLength(0);
      expect(session.status).toBe(status === "open" ? "expired" : "complete");
      expect(expireSession.mock.calls.filter(([sessionId]) => sessionId === id))
        .toHaveLength(expirationsBefore + (status === "open" ? 1 : 0));
      await recoverQueuedCheckoutExpirations();
      expect(retrieveSession.mock.calls.filter(([sessionId]) => sessionId === id)).toHaveLength(retrievesAfterRetry);
    } finally {
      retrieveSession.mockImplementation(originalRetrieve);
      await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id]);
      sessions.delete(id);
    }
  },
);

test("recovery keeps a checkout paid between lookup and expiration, then clears its retry", async () => {
  const id = `cs_${randomUUID()}`;
  const session: TestSession = { id, status: "open", url: "https://checkout.stripe.test/race",
    created: Math.floor(Date.now() / 1000) };
  sessions.set(id, session);
  await pool.query("INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1)", [id]);
  const queued = async () => (await pool.query(
    "SELECT stripe_session_id FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id],
  )).rows;
  const retrievedBefore = retrieveSession.mock.calls.length;
  let retrievedBeforeExpiration = false;
  let statusAtExpiration: string | undefined;
  expireSession.mockImplementationOnce(async (sessionId: string) => {
    retrievedBeforeExpiration = retrieveSession.mock.calls.slice(retrievedBefore).some(([retrievedId]) => retrievedId === sessionId);
    statusAtExpiration = session.status;
    session.status = "complete";
    session.payment_status = "paid";
    session.subscription = `sub_${randomUUID()}`;
    throw new Error("Stripe cannot expire a completed checkout session");
  });

  try {
    await recoverQueuedCheckoutExpirations();
    expect(session).toMatchObject({ id, status: "complete", payment_status: "paid" });
    expect(await queued()).toHaveLength(1);
    const expirations = expireSession.mock.calls.filter(([sessionId]) => sessionId === id).length;
    expect(expirations).toBe(1);
    expect(retrievedBeforeExpiration).toBe(true);
    expect(statusAtExpiration).toBe("open");

    await recoverQueuedCheckoutExpirations();
    expect(await queued()).toHaveLength(0);
    expect(expireSession.mock.calls.filter(([sessionId]) => sessionId === id)).toHaveLength(expirations);
    expect(session).toMatchObject({ id, status: "complete", payment_status: "paid", subscription: expect.any(String) });
  } finally {
    await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = $1", [id]);
    sessions.delete(id);
  }
});

test("lost Stripe responses leave recoverable sessions; recovery expires only untracked open checkouts", async () => {
  clock(opens);
  const [openBuyer, paidBuyer, trackedBuyer] = await Promise.all([addUser(210), addUser(211), addUser(212)]);
  const originalCreate = createSession.getMockImplementation()!;
  const loseResponse = async (...args: Parameters<typeof originalCreate>) => {
    await originalCreate(...args); // Stripe created it, but its response never reached the server.
    throw new Error("Connection lost after Stripe accepted checkout");
  };
  const before = sessions.size;
  createSession.mockImplementationOnce(loseResponse).mockImplementationOnce(loseResponse);
  expect((await request("/membership/checkout", "POST", openBuyer, { kind: "standard" })).status).toBe(503);
  expect((await request("/membership/checkout", "POST", paidBuyer, { kind: "standard" })).status).toBe(503);
  expect(await row(openBuyer)).toBeUndefined();
  expect(await row(paidBuyer)).toBeUndefined();
  const [orphan, completed] = [...sessions.values()].slice(before);
  expect(orphan.metadata).toMatchObject({ membershipCheckout: "true", reservationId: expect.any(String) });
  expect(createSession.mock.calls.some(([, options]) => options?.idempotencyKey === `membership-${orphan.metadata?.reservationId}`)).toBe(true);
  expect(expireSession).not.toHaveBeenCalledWith(orphan.id);
  completed.status = "complete";
  completed.payment_status = "paid";
  completed.subscription = `sub_${randomUUID()}`;
  // A lost response has no local row, but the paid Stripe checkout can still be restored.
  expect(await webhook("checkout.session.completed", {
    object: "checkout.session", id: completed.id, payment_status: "paid", subscription: completed.subscription,
  })).toBe(200);
  expect(await row(paidBuyer)).toMatchObject({ status: "confirmed", membership_tier: "Elevated" });

  expect((await request("/membership/checkout", "POST", trackedBuyer, { kind: "standard" })).status).toBe(200);
  const tracked = sessions.get((await row(trackedBuyer)).stripe_session_id)!;
  const unrelated: TestSession = { id: `cs_${randomUUID()}`, status: "open", url: "https://checkout.stripe.test/other",
    created: orphan.created, metadata: { reservationId: "999999" } };
  sessions.set(unrelated.id, unrelated);

  clock(opens + 32 * 60 * 1000);
  const beforeListing = listSessions.mock.calls.filter(([params]) => params.status === "open").length;
  expect((await request("/membership/offer")).status).toBe(200);
  expect((await request("/membership/checkout", "POST", trackedBuyer, { kind: "standard" })).status).toBe(200);
  expect(listSessions.mock.calls.filter(([params]) => params.status === "open")).toHaveLength(beforeListing);
  expect(orphan.status).toBe("open");

  // The listing may still include a session that completed during pagination.
  listSessions.mockImplementationOnce(async () => ({
    data: [orphan, unrelated], has_more: true,
  })).mockImplementationOnce(async () => ({
    data: [completed, tracked], has_more: false,
  }));
  await expireUntrackedMembershipSessions();
  expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({
    status: "open", created: { lte: Math.floor(Date.now() / 1000) - 31 * 60 },
  }));
  expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ starting_after: unrelated.id }));
  expect(sessions.get(orphan.id)?.status).toBe("expired");
  expect(expireSession).toHaveBeenCalledWith(orphan.id);
  expect(expireSession).not.toHaveBeenCalledWith(completed.id);
  expect(completed.status).toBe("complete");
  expect(tracked.status).toBe("open");
  expect(unrelated.status).toBe("open");
  expect((await row(trackedBuyer)).status).toBe("pending");
  vi.restoreAllMocks();
});

test("orphan cleanup continues past failed candidates and pages, then retries them safely", async () => {
  clock(opens);
  const buyer = await addUser(217);
  expect((await request("/membership/checkout", "POST", buyer, { kind: "standard" })).status).toBe(200);
  const tracked = sessions.get((await row(buyer)).stripe_session_id)!;
  const old = Math.floor(opens / 1000);
  const candidate = (reservationId: string): TestSession => ({
    id: `cs_${randomUUID()}`, status: "open", url: "https://checkout.stripe.test/old",
    created: old, metadata: { membershipCheckout: "true", reservationId },
  });
  const malformed = candidate("not-a-reservation-id");
  const lookupFails = candidate("0");
  const expiryFails = candidate("0");
  const laterPage = candidate("0");
  const paid = { ...candidate("0"), payment_status: "paid" };
  const added = [malformed, lookupFails, expiryFails, laterPage, paid];
  for (const session of added) sessions.set(session.id, session);
  const originalRetrieve = retrieveSession.getMockImplementation()!;

  const originalExpire = expireSession.getMockImplementation()!;
  const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    retrieveSession.mockImplementation(async id => {
      if (id === lookupFails.id) throw new Error("Temporary Stripe lookup failure");
      return originalRetrieve(id);
    });
    expireSession.mockImplementation(async id => {
      if (id === expiryFails.id) throw new Error("Temporary Stripe expiration failure");
      return originalExpire(id);
    });
    listSessions.mockImplementationOnce(async () => ({
      data: [malformed, lookupFails, expiryFails, tracked, paid], has_more: true,
    })).mockImplementationOnce(async () => ({
      data: [laterPage], has_more: false,
    }));

    clock(opens + 32 * 60 * 1000);
    await expireUntrackedMembershipSessions();
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ starting_after: paid.id }));
    expect(laterPage.status).toBe("expired");
    expect([malformed, lookupFails, expiryFails].map(s => s.status)).toEqual(["open", "open", "open"]);
    expect(tracked.status).toBe("open");
    expect(paid.status).toBe("open");
    expect(expireSession).not.toHaveBeenCalledWith(tracked.id);
    expect(expireSession).not.toHaveBeenCalledWith(paid.id);
    for (const session of [malformed, lookupFails, expiryFails]) {
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), stripeSessionId: session.id }),
        "Membership orphan session cleanup failed",
      );
    }

    // No failed candidate is recorded as complete; a later sweep can retry it.
    malformed.metadata!.reservationId = "0";
    retrieveSession.mockImplementation(originalRetrieve);
    expireSession.mockImplementation(originalExpire);
    await expireUntrackedMembershipSessions();
    expect([malformed, lookupFails, expiryFails].map(s => s.status)).toEqual(["expired", "expired", "expired"]);
    expect(tracked.status).toBe("open");
    expect(paid.status).toBe("open");
    expect(expireSession).not.toHaveBeenCalledWith(tracked.id);
    expect(expireSession).not.toHaveBeenCalledWith(paid.id);
  } finally {
    retrieveSession.mockImplementation(originalRetrieve);
    expireSession.mockImplementation(originalExpire);
    for (const session of added) sessions.delete(session.id);
    vi.restoreAllMocks();
  }
});

test("simultaneous orphan recovery attempts scan once and a later retry can scan again", async () => {
  clock(opens + 32 * 60 * 1000);
  const created = Math.floor(opens / 1000);
  const first: TestSession = {
    id: `cs_${randomUUID()}`, status: "open", url: "https://checkout.stripe.test/first",
    created, metadata: { membershipCheckout: "true", reservationId: "9000000000000000000" },
  };
  const later: TestSession = {
    id: `cs_${randomUUID()}`, status: "open", url: "https://checkout.stripe.test/later",
    created, metadata: { membershipCheckout: "true", reservationId: "9000000000000000001" },
  };
  sessions.set(first.id, first);
  sessions.set(later.id, later);
  let signalListing!: () => void;
  const listingStarted = new Promise<void>(resolve => { signalListing = resolve; });
  let releaseListing!: () => void;
  const listingReleased = new Promise<void>(resolve => { releaseListing = resolve; });
  listSessions.mockImplementationOnce(async () => {
    signalListing();
    await listingReleased;
    return { data: [first], has_more: false };
  });
  const listingsBefore = listSessions.mock.calls.length;
  const expirationsBefore = expireSession.mock.calls.length;
  const firstAttempt = expireUntrackedMembershipSessions();
  let secondAttempt: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await listingStarted; // The first connection holds the advisory lock inside Stripe.list.
      secondAttempt = expireUntrackedMembershipSessions();
      await Promise.race([
        secondAttempt,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Second orphan recovery waited for the first scan")), 1500);
        }),
      ]);
      expect(listSessions.mock.calls).toHaveLength(listingsBefore + 1);
      expect(expireSession.mock.calls).toHaveLength(expirationsBefore);
      expect(first.status).toBe("open");
      expect(later.status).toBe("open");
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseListing();
      await firstAttempt;
      if (secondAttempt) await secondAttempt;
    }

    expect(first.status).toBe("expired");
    expect(later.status).toBe("open");
    listSessions.mockImplementationOnce(async () => ({ data: [later], has_more: false }));
    await expireUntrackedMembershipSessions();
    expect(listSessions.mock.calls).toHaveLength(listingsBefore + 2);
    expect(expireSession.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
    expect(expireSession.mock.calls.filter(([id]) => id === later.id)).toHaveLength(1);
    expect(later.status).toBe("expired");
  } finally {
    sessions.delete(first.id);
    sessions.delete(later.id);
    vi.restoreAllMocks();
  }
});

test("slow Stripe orphan listing cannot hold up offer or checkout requests", async () => {
  clock(opens);
  const buyer = await addUser(217);
  let release!: (page: { data: TestSession[]; has_more: boolean }) => void;
  listSessions.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const sweep = expireUntrackedMembershipSessions();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const responses = await Promise.race([
      Promise.all([
        request("/membership/offer"),
        request("/membership/checkout", "POST", buyer, { kind: "standard" }),
      ]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Offer or checkout waited for Stripe listing")), 1500);
      }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(listSessions.mock.calls.filter(([params]) => params.status === "open")).toHaveLength(1);
  } finally {
    if (timeout) clearTimeout(timeout);
    release({ data: [], has_more: false });
    await sweep;
    vi.restoreAllMocks();
  }
});

test("paid founding recovery via later reconciliation counts once and rejects mismatched Stripe ownership", async () => {
  clock(opens);
  const buyer = await addUser(217);
  const count = async () => Number((await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM membership_checkouts WHERE kind = 'founding' AND status IN ('pending', 'confirmed', 'forfeited')",
  )).rows[0].count);
  const foundingBefore = await count();
  const originalCreate = createSession.getMockImplementation()!;
  createSession.mockImplementationOnce(async (...args: Parameters<typeof originalCreate>) => {
    await originalCreate(...args);
    throw new Error("Response lost");
  });
  expect((await request("/membership/checkout", "POST", buyer, { kind: "founding" })).status).toBe(503);
  const session = [...sessions.values()].at(-1)!;
  expect(await row(buyer)).toBeUndefined();
  session.status = "complete";
  session.payment_status = "paid";
  session.subscription = `sub_${randomUUID()}`;
  const customer = customers.get(session.customer!)!;
  customer.metadata.clerkId = "wrong-owner";
  await reconcileUntrackedPaidSessions();
  expect(await row(buyer)).toBeUndefined();
  customer.metadata.clerkId = buyer;
  const before = createSession.mock.calls.length;
  await reconcileUntrackedPaidSessions();
  expect(await row(buyer)).toMatchObject({ status: "confirmed", membership_tier: "Elevated", stripe_session_id: session.id });
  expect(await count()).toBe(foundingBefore + 1);
  const completeLists = listSessions.mock.calls.filter(([params]) => params.status === "complete").length;
  await reconcileUntrackedPaidSessions();
  expect(listSessions.mock.calls.filter(([params]) => params.status === "complete").length).toBeGreaterThan(completeLists);
  expect(await count()).toBe(foundingBefore + 1);
  expect((await pool.query("SELECT 1 FROM membership_checkouts WHERE stripe_session_id = $1", [session.id])).rows).toHaveLength(1);
  expect(createSession.mock.calls.length).toBe(before);
  vi.restoreAllMocks();
});

test("webhook and paid-session reconciliation cannot restore the same missing founding reservation twice", async () => {
  clock(opens);
  const buyer = await addUser(218);
  const count = async () => Number((await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM membership_checkouts WHERE kind = 'founding' AND status IN ('pending', 'confirmed', 'forfeited')",
  )).rows[0].count);
  const foundingBefore = await count();
  const originalCreate = createSession.getMockImplementation()!;
  createSession.mockImplementationOnce(async (...args: Parameters<typeof originalCreate>) => {
    await originalCreate(...args);
    throw new Error("Response lost");
  });
  expect((await request("/membership/checkout", "POST", buyer, { kind: "founding" })).status).toBe(503);
  const session = [...sessions.values()].at(-1)!;
  expect(await row(buyer)).toBeUndefined();
  session.status = "complete";
  session.payment_status = "paid";
  session.subscription = `sub_${randomUUID()}`;

  const createdBefore = createSession.mock.calls.length;
  const expiredBefore = expireSession.mock.calls.length;
  const originalRetrieve = retrieveSession.getMockImplementation()!;
  let enterRetrieve!: () => void;
  let releaseRetrieve!: () => void;
  const entered = new Promise<void>(resolve => { enterRetrieve = resolve; });
  const released = new Promise<void>(resolve => { releaseRetrieve = resolve; });
  retrieveSession.mockImplementation(async id => {
    if (id === session.id) {
      enterRetrieve();
      await released;
    }
    return originalRetrieve(id);
  });

  const delivery = webhook("checkout.session.completed", {
    object: "checkout.session", id: session.id, payment_status: "paid", subscription: session.subscription,
  });
  let sweep: Promise<void> | undefined;
  try {
    await entered;
    sweep = reconcileUntrackedPaidSessions();
    const deadline = realNow() + 5000;
    while (true) {
      const waiting = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND classid = 20261001 AND objid = 50 AND NOT granted`,
      );
      if (Number(waiting.rows[0].count) > 0) break;
      if (realNow() > deadline) throw new Error("Reconciliation never waited for the capacity lock");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    releaseRetrieve();
    retrieveSession.mockImplementation(originalRetrieve);
    await Promise.allSettled([delivery, ...(sweep ? [sweep] : [])]);
  }
  expect(await delivery).toBe(200);
  if (sweep) await sweep;

  const restored = await pool.query<{ status: string; stripe_session_id: string }>(
    "SELECT status, stripe_session_id FROM membership_checkouts WHERE clerk_id = $1 OR stripe_session_id = $2",
    [buyer, session.id],
  );
  expect(restored.rows).toEqual([{ status: "confirmed", stripe_session_id: session.id }]);
  expect(await row(buyer)).toMatchObject({ membership_tier: "Elevated" });
  expect(await count()).toBe(foundingBefore + 1);
  expect(createSession.mock.calls.length).toBe(createdBefore);
  expect(expireSession.mock.calls.length).toBe(expiredBefore);
  expect(session.status).toBe("complete");
  vi.restoreAllMocks();
});

test("queued cleanup restores a paid checkout with no reservation without expiring or charging again", async () => {
  clock(opens);
  const buyer = await addUser(217);
  expect((await request("/membership/checkout", "POST", buyer, { kind: "standard" })).status).toBe(200);
  const session = sessions.get((await row(buyer)).stripe_session_id)!;
  await pool.query("DELETE FROM membership_checkouts WHERE stripe_session_id = $1", [session.id]);
  session.status = "complete";
  session.payment_status = "paid";
  session.subscription = `sub_${randomUUID()}`;
  await pool.query("INSERT INTO membership_checkout_expirations (stripe_session_id) VALUES ($1)", [session.id]);
  const expiredBefore = expireSession.mock.calls.length;
  const createdBefore = createSession.mock.calls.length;
  await recoverQueuedCheckoutExpirations();
  expect(await row(buyer)).toMatchObject({ status: "confirmed", stripe_session_id: session.id, membership_tier: "Elevated" });
  expect(expireSession.mock.calls.length).toBe(expiredBefore);
  expect(createSession.mock.calls.length).toBe(createdBefore);
  expect((await pool.query("SELECT 1 FROM membership_checkout_expirations WHERE stripe_session_id = $1", [session.id])).rows).toHaveLength(0);
  vi.restoreAllMocks();
});

test("founding inventory and payment failures retain their original guarantees", async () => {
  clock(opens);
  const existing = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM membership_checkouts WHERE kind = 'founding' AND status IN ('pending', 'confirmed', 'forfeited')",
  );
  const fill = FOUNDING_LIMIT - 1 - Number(existing.rows[0].count);
  if (fill < 0) throw new Error("Development database already has all founding places reserved");
  for (let i = 0; i < fill; i++) {
    const id = await addUser(i + 1);
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'founding', 'confirmed')", [id],
    );
  }
  const [a, b, c] = await Promise.all([addUser(100), addUser(101), addUser(102)]);
  expect(await request("/membership/offer")).toMatchObject({
    status: 200, data: { phase: "open", foundingAvailable: true },
  });
  const creationsBeforeRace = createSession.mock.calls.length;
  const results = await Promise.all([
    request("/membership/checkout", "POST", a, { kind: "founding" }),
    request("/membership/checkout", "POST", b, { kind: "founding" }),
  ]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(createSession.mock.calls.length - creationsBeforeRace).toBe(1);
  const winner = results[0].status === 200 ? a : b;
  expect((await request("/membership/offer")).data).toMatchObject({ phase: "open", foundingAvailable: false });
  expect((await request("/membership/checkout", "POST", c, { kind: "founding" })).status).toBe(409);

  const pending = await row(winner);
  await pool.query("UPDATE membership_checkouts SET created_at = now() - interval '32 minutes' WHERE clerk_id = $1", [winner]);
  const stale = await pool.query<{ stripe_session_id: string }>(
    "SELECT stripe_session_id FROM membership_checkouts WHERE status = 'pending' AND created_at < now() - interval '31 minutes' AND stripe_session_id IS NOT NULL",
  );
  expect(stale.rows.map(item => item.stripe_session_id)).toContain(pending.stripe_session_id);
  // Time alone cannot release inventory; Stripe still reports this session as open.
  expect((await request("/membership/offer")).data.foundingAvailable).toBe(false);
  expect((await row(winner)).status).toBe("pending");
  const retrievedBefore = retrieveSession.mock.calls.length;
  sessions.set(pending.stripe_session_id, { ...sessions.get(pending.stripe_session_id)!, status: "expired", url: "" });
  const afterExpiration = await request("/membership/offer");
  expect(retrieveSession.mock.calls.length).toBeGreaterThan(retrievedBefore);
  expect(retrieveSession.mock.calls.at(-1)?.[0]).toBe(pending.stripe_session_id);
  expect(await retrieveSession.mock.results.at(-1)?.value).toMatchObject({ status: "expired" });
  expect((await row(winner)).status).toBe("expired");
  expect(afterExpiration).toMatchObject({ status: 200, data: { foundingAvailable: true } });
  expect((await request("/membership/checkout", "POST", c, { kind: "founding" })).status).toBe(200);
  const replacement = await row(c);
  const complete = { object: "checkout.session", id: replacement.stripe_session_id, payment_status: "paid", subscription: `sub_${prefix}` };
  const completeEvent = `evt_complete_${prefix}`;
  expect(await webhook("checkout.session.completed", complete, completeEvent)).toBe(200);
  expect(await webhook("checkout.session.completed", complete, completeEvent)).toBe(200);
  expect(await webhook("checkout.session.completed", complete)).toBe(200);
  expect(await row(c)).toMatchObject({ status: "confirmed", membership_tier: "Elevated" });
  expect((await request("/membership/offer")).data.foundingAvailable).toBe(false);
  expect(await webhook("checkout.session.expired", { object: "checkout.session", id: replacement.stripe_session_id })).toBe(200);
  expect((await row(c)).status).toBe("confirmed");
  expect((await request("/membership/offer")).data.foundingAvailable).toBe(false);

  const invoice = {
    object: "invoice", id: `in_${prefix}`, billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: `sub_${prefix}` } },
  };
  const recordFailure = (id: string, date: string) => {
    invoiceHistory.push({
      id, created: Date.parse(date) / 1000, status: "open",
      attempt_count: 1, billing_reason: "subscription_cycle",
    });
  };
  recordFailure(invoice.id, "2026-11-01T00:00:00Z");
  const failedEvent = `evt_failed_${prefix}`;
  expect(await webhook("invoice.payment_failed", invoice, failedEvent)).toBe(200);
  expect(await webhook("invoice.payment_failed", invoice, failedEvent)).toBe(200);
  expect(await webhook("invoice.payment_failed", invoice)).toBe(200);
  const retry = { ...invoice, id: `in_${prefix}_retry` };
  recordFailure(retry.id, "2026-11-10T00:00:00Z");
  expect(await webhook("invoice.payment_failed", retry)).toBe(200);
  expect(await row(c)).toMatchObject({ status: "confirmed", failed_months: 1, membership_tier: "Elevated" });
  expect(cancelSubscription).not.toHaveBeenCalled();
  for (const [number, date] of [[2, "2026-12-01T00:00:00Z"], [3, "2027-01-01T00:00:00Z"]] as const) {
    const nextInvoice = { ...invoice, id: `in_${prefix}_${number}` };
    recordFailure(nextInvoice.id, date);
    expect(await webhook("invoice.payment_failed", nextInvoice)).toBe(200);
    expect(await webhook("invoice.payment_failed", nextInvoice)).toBe(200);
  }
  expect(cancelSubscription).toHaveBeenCalledTimes(1);
  expect(cancelSubscription).toHaveBeenCalledWith(`sub_${prefix}`);
  expect(await row(c)).toMatchObject({ status: "forfeited", failed_months: 3, membership_tier: "Free" });
  expect((await request("/membership/offer")).data.foundingAvailable).toBe(false);
  expect(processWebhook).toHaveBeenCalled();
  vi.restoreAllMocks();
});
