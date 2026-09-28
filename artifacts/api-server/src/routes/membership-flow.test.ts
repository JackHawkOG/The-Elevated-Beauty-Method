import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
import { FOUNDING_LIMIT } from "../lib/membership-reservations";
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

type TestSession = {
  id: string; status: string; url: string; created: number;
  metadata?: { reservationId: string; membershipCheckout?: string };
  payment_status?: string; subscription?: string;
};
const sessions = new Map<string, TestSession>();
const createSession = vi.fn(async (params?: { metadata?: TestSession["metadata"] }, options?: { idempotencyKey?: string }) => {
  const id = `cs_${randomUUID()}`;
  const session: TestSession = { id, status: "open", url: `https://checkout.stripe.test/${id}`,
    created: Math.floor(Date.now() / 1000), metadata: params?.metadata };
  sessions.set(id, session);
  return session;
});

const listSessions = vi.fn(async (params: { status: string; created: { lte: number }; limit: number; starting_after?: string }) => {
  const eligible = [...sessions.values()].filter(s => s.status === params.status && s.created <= params.created.lte);
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
      { id: "price_founder_test", unit_amount: 2400, currency: "usd", recurring: { interval: "month" } },
      { id: "price_standard_test", unit_amount: 4800, currency: "usd", recurring: { interval: "month" } },
    ] }) },
    customers: { create: async () => ({ id: `cus_${randomUUID()}` }) },
    checkout: { sessions: { create: createSession, list: listSessions, retrieve: retrieveSession, expire: expireSession } },
    invoices: { list: async () => ({ data: [...invoiceHistory].sort((a, b) => b.created - a.created), has_more: false }) },
    subscriptions: {
      retrieve: async (id: string) => ({
        id, status: subscriptionStatus, cancel_at: null, cancel_at_period_end: false, items: { data: [] },
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
  const id = `${prefix}-${index}`;
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
  const buyer = await addUser(0);
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
  const buyer = await addUser(201);
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
  const session = await createSession.mock.results[creationsBefore].value;
  expect(response.status).toBe(503);
  expect(response.data.url).toBeUndefined();
  expect(expireSession).toHaveBeenCalledWith(session.id);
  expect(sessions.get(session.id)).toMatchObject({ status: "expired", url: "" });
  expect(await row(buyer)).toBeUndefined();
  vi.restoreAllMocks();
});

test("failed Stripe cleanup is queued and retried without returning a checkout URL", async () => {
  clock(opens);
  const buyer = await addUser(202);
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
  const session = await createSession.mock.results[creationsBefore].value;
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
  const expirations = expireSession.mock.calls.filter(([id]) => id === session.id).length;
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
  expect(createSession.mock.calls.at(-2)?.[1]?.idempotencyKey).toBe(`membership-${orphan.metadata?.reservationId}`);
  expect(expireSession).not.toHaveBeenCalledWith(orphan.id);
  completed.status = "complete";
  completed.payment_status = "paid";
  completed.subscription = `sub_${randomUUID()}`;

  expect((await request("/membership/checkout", "POST", trackedBuyer, { kind: "standard" })).status).toBe(200);
  const tracked = sessions.get((await row(trackedBuyer)).stripe_session_id)!;
  const unrelated: TestSession = { id: `cs_${randomUUID()}`, status: "open", url: "https://checkout.stripe.test/other",
    created: orphan.created, metadata: { reservationId: "999999" } };
  sessions.set(unrelated.id, unrelated);

  clock(opens + 32 * 60 * 1000);
  const beforeListing = listSessions.mock.calls.length;
  expect((await request("/membership/offer")).status).toBe(200);
  expect((await request("/membership/checkout", "POST", trackedBuyer, { kind: "standard" })).status).toBe(200);
  expect(listSessions.mock.calls).toHaveLength(beforeListing);
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

test("slow Stripe orphan listing cannot hold up offer or checkout requests", async () => {
  clock(opens);
  const buyer = await addUser(213);
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
    expect(listSessions).toHaveBeenCalledTimes(1);
  } finally {
    if (timeout) clearTimeout(timeout);
    release({ data: [], has_more: false });
    await sweep;
    vi.restoreAllMocks();
  }
});

test("concurrent last-place checkouts reserve once; only confirmed Stripe expiration releases a place", async () => {
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
