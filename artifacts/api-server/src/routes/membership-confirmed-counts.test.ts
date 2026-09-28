import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
import { confirmCheckout } from "../lib/membership-reservations";
import { requireDevelopmentDatabase } from "./test-development-database";
import type Stripe from "stripe";
import { recoverCheckoutExpiration, retryQueuedCheckoutExpiration } from "../lib/membership-checkout-expirations";

const stripeClient = vi.hoisted(() => ({ getUncachableStripeClient: vi.fn() }));
vi.mock("../lib/stripeClient", () => ({ ...stripeClient, getStripeSync: vi.fn() }));

// Keep the real authentication middleware and route, replacing only Clerk's
// session and metadata lookups for this isolated HTTP server.
const getUser = vi.fn(async (id: string) => ({
  publicMetadata: {
    role: id.startsWith("owner-") ? "owner" : id.startsWith("admin-") ? "admin" : "member",
  },
}));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser } },
}));

const prefix = `membership-counts-${randomUUID()}`;
const ids = Array.from({ length: 5 }, (_, index) => `${prefix}-${index}`);
const owner = `owner-${prefix}`;
const admin = `admin-${prefix}`;
const member = `member-${prefix}`;
let server: Server | undefined;
let baseUrl: string;
let fixtureLock: PoolClient | undefined;
let safeToCleanup = false;

async function counts(user?: string) {
  const response = await fetch(`${baseUrl}/membership/confirmed-counts`, {
    headers: user ? { "x-test-user": user } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function cleanupAlerts(user?: string) {
  const response = await fetch(`${baseUrl}/membership/checkout-cleanup-alerts`, {
    headers: user ? { "x-test-user": user } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function retryCleanup(sessionId: string, user?: string) {
  const response = await fetch(`${baseUrl}/membership/checkout-cleanup-alerts/${encodeURIComponent(sessionId)}/retry`, {
    method: "POST",
    headers: user ? { "x-test-user": user } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  safeToCleanup = true;
  fixtureLock = await pool.connect();
  // Shared with the membership flow/capacity suites, for their entire fixture lifetime.
  await fixtureLock.query("SELECT pg_advisory_lock(20261001, 55)");
  await ensureMembershipSchema();
  const { default: router } = await import("./membership");
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (safeToCleanup) {
      await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [ids]);
    }
  } finally {
    if (fixtureLock) {
      await fixtureLock.query("SELECT pg_advisory_unlock(20261001, 55)");
      fixtureLock.release();
    }
    await pool.end();
  }
});

test("only authenticated owners and admins can read confirmed counts", async () => {
  expect((await counts()).status).toBe(401);
  expect(getUser).not.toHaveBeenCalled();
  expect((await counts(member)).status).toBe(403);
  expect((await counts(owner)).status).toBe(200);
  expect((await counts(admin)).status).toBe(200);
});

test("overdue checkout cleanup alerts are staff-only and clear after Stripe confirms resolution", async () => {
  const sessionId = `cs_alert_${randomUUID()}`;
  const recentId = `cs_alert_${randomUUID()}`;
  try {
    await pool.query(
      `INSERT INTO membership_checkout_expirations (stripe_session_id, created_at)
       VALUES ($1, now() - interval '11 minutes'), ($2, now())`,
      [sessionId, recentId],
    );
    expect((await cleanupAlerts()).status).toBe(401);
    expect((await cleanupAlerts(member)).status).toBe(403);
    for (const staff of [owner, admin]) {
      const result = await cleanupAlerts(staff);
      expect(result.status).toBe(200);
      expect(result.body.sessions).toContainEqual({ sessionId, queuedAt: expect.any(String) });
      expect(result.body.sessions).not.toEqual(expect.arrayContaining([{ sessionId: recentId, queuedAt: expect.any(String) }]));
      expect(JSON.stringify(result.body)).not.toContain("https://");
    }
    const stripe = { checkout: { sessions: {
      retrieve: vi.fn().mockResolvedValue({ status: "open", payment_status: "unpaid" }),
      expire: vi.fn().mockRejectedValueOnce(new Error("Stripe unavailable")).mockResolvedValue({ status: "expired" }),
    } } } as unknown as Stripe;
    await expect(recoverCheckoutExpiration(sessionId, stripe)).rejects.toThrow("Stripe unavailable");
    expect((await cleanupAlerts(owner)).body.sessions).toContainEqual({ sessionId, queuedAt: expect.any(String) });
    await recoverCheckoutExpiration(sessionId, stripe);
    expect((await cleanupAlerts(owner)).body.sessions).not.toEqual(expect.arrayContaining([{ sessionId, queuedAt: expect.any(String) }]));

    await pool.query("UPDATE membership_checkout_expirations SET created_at = now() - interval '11 minutes' WHERE stripe_session_id = $1", [recentId]);
    for (const session of [
      { status: "expired", payment_status: "unpaid" },
      { status: "complete", payment_status: "unpaid" },
      { status: "open", payment_status: "paid" },
    ]) {
      const confirmed = { checkout: { sessions: {
        retrieve: vi.fn().mockResolvedValue(session),
        expire: vi.fn(),
      } } } as unknown as Stripe;
      await recoverCheckoutExpiration(recentId, confirmed);
      expect(confirmed.checkout.sessions.expire).not.toHaveBeenCalled();
      expect((await cleanupAlerts(owner)).body.sessions).not.toEqual(expect.arrayContaining([{ sessionId: recentId, queuedAt: expect.any(String) }]));
      if (session.status !== "open") await pool.query(
        "INSERT INTO membership_checkout_expirations (stripe_session_id, created_at) VALUES ($1, now() - interval '11 minutes')",
        [recentId],
      );
    }
  } finally {
    await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = ANY($1::text[])", [[sessionId, recentId]]);
  }
});

test("staff retry only overdue queued sessions; Stripe failures keep alerts and paid sessions are never expired", async () => {
  const sessionId = `cs_retry_${randomUUID().replaceAll("-", "")}`;
  const recentId = `cs_retry_${randomUUID().replaceAll("-", "")}`;
  const expire = vi.fn();
  const retrieve = vi.fn();
  stripeClient.getUncachableStripeClient.mockResolvedValue({ checkout: { sessions: { retrieve, expire } } });
  try {
    await pool.query(
      `INSERT INTO membership_checkout_expirations (stripe_session_id, created_at)
       VALUES ($1, now() - interval '11 minutes'), ($2, now())`,
      [sessionId, recentId],
    );
    expect((await retryCleanup(sessionId)).status).toBe(401);
    expect((await retryCleanup(sessionId, member)).status).toBe(403);
    expect((await retryCleanup("not-a-session", owner)).status).toBe(400);
    expect((await retryCleanup(recentId, owner)).status).toBe(404);
    expect(retrieve).not.toHaveBeenCalled();

    retrieve.mockRejectedValueOnce(new Error("Stripe unavailable"));
    expect((await retryCleanup(sessionId, owner)).status).toBe(503);
    expect((await cleanupAlerts(owner)).body.sessions).toContainEqual({ sessionId, queuedAt: expect.any(String) });

    retrieve.mockResolvedValueOnce({ status: "open", payment_status: "unpaid" });
    expire.mockRejectedValueOnce(new Error("Stripe unavailable"));
    expect((await retryCleanup(sessionId, admin)).status).toBe(503);
    expect((await cleanupAlerts(owner)).body.sessions).toContainEqual({ sessionId, queuedAt: expect.any(String) });

    for (const resolved of [
      { status: "complete", payment_status: "unpaid" },
      { status: "complete", payment_status: "paid" },
      { status: "open", payment_status: "paid" },
    ]) {
      retrieve.mockResolvedValue(resolved);
      expect(await retryCleanup(sessionId, owner)).toEqual({ status: 200, body: { resolved: true } });
      expect((await cleanupAlerts(owner)).body.sessions).not.toEqual(expect.arrayContaining([{ sessionId, queuedAt: expect.any(String) }]));
      expect(expire).toHaveBeenCalledTimes(1); // Only the earlier failed unpaid attempt.
      if (resolved.status !== "open") await pool.query(
        "INSERT INTO membership_checkout_expirations (stripe_session_id, created_at) VALUES ($1, now() - interval '11 minutes')",
        [sessionId],
      );
    }
    expect((await retryCleanup(sessionId, admin)).status).toBe(404);
    retrieve.mockResolvedValue({ status: "open", payment_status: "unpaid" });
    expire.mockResolvedValue({ status: "expired" });
    await pool.query(
      "INSERT INTO membership_checkout_expirations (stripe_session_id, created_at) VALUES ($1, now() - interval '11 minutes')",
      [sessionId],
    );
    expect(await retryCleanup(sessionId, admin)).toEqual({ status: 200, body: { resolved: true } });
    expect(expire).toHaveBeenCalledTimes(2);
    expect((await cleanupAlerts(owner)).body.sessions).not.toEqual(expect.arrayContaining([{ sessionId, queuedAt: expect.any(String) }]));
  } finally {
    await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = ANY($1::text[])", [[sessionId, recentId]]);
    stripeClient.getUncachableStripeClient.mockReset();
  }
});

test("parallel queued retries finish without waiting for a second database connection", async () => {
  const sessions = Array.from({ length: 8 }, () => `cs_parallel_${randomUUID().replaceAll("-", "")}`);
  let arrived = 0;
  let releaseStripe!: () => void;
  const stripeGate = new Promise<void>(resolve => { releaseStripe = resolve; });
  let allArrived!: () => void;
  const reachedStripe = new Promise<void>(resolve => { allArrived = resolve; });
  const stripe = { checkout: { sessions: {
    retrieve: vi.fn(async () => {
      if (++arrived === sessions.length) allArrived();
      await stripeGate;
      return { status: "open", payment_status: "unpaid" };
    }),
    expire: vi.fn(async () => ({ status: "expired" })),
  } } } as unknown as Stripe;
  try {
    for (const id of sessions) await pool.query(
      "INSERT INTO membership_checkout_expirations (stripe_session_id, created_at) VALUES ($1, now() - interval '11 minutes')",
      [id],
    );
    const retries = sessions.map(id => retryQueuedCheckoutExpiration(id, async () => stripe, true));
    await Promise.race([
      reachedStripe,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Concurrent retries did not reach Stripe")), 5000)),
    ]);
    releaseStripe();
    expect(await Promise.all(retries)).toEqual(sessions.map(() => "resolved"));
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(sessions.length);
  } finally {
    releaseStripe();
    await pool.query("DELETE FROM membership_checkout_expirations WHERE stripe_session_id = ANY($1::text[])", [sessions]);
  }
});

test("counts unique confirmed members, not checkout starts or browser returns", async () => {
  const baseline = (await counts(owner)).body;
  expect(baseline).toEqual({
    founding: expect.any(Number),
    standard: expect.any(Number),
  });
  for (const id of ids) {
    await pool.query("INSERT INTO users (clerk_id, display_name, email) VALUES ($1, $1, $2)", [id, `${id}@example.invalid`]);
  }
  // A paid Stripe checkout starts as pending; no success-page request is made.
  const session = `cs_${prefix}`;
  await pool.query(
    "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_session_id) VALUES ($1, 'founding', 'pending', $2)",
    [ids[0], session],
  );
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'standard', 'pending')", [ids[2]]);
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'founding', 'forfeited')", [ids[3]]);
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'standard', 'forfeited')", [ids[4]]);
  expect((await counts(admin)).body).toEqual(baseline);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    expect(await confirmCheckout(client, session, `sub_${prefix}`)).toBe(true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  expect((await counts(owner)).body).toEqual({
    founding: (baseline.founding as number) + 1,
    standard: baseline.standard,
  });

  // Historical duplicate confirmed checkouts count a person only once per kind.
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'founding', 'confirmed')", [ids[0]]);
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'founding', 'confirmed')", [ids[1]]);
  await pool.query("INSERT INTO membership_checkouts (clerk_id, kind, status) VALUES ($1, 'standard', 'confirmed')", [ids[2]]);
  expect((await counts(admin)).body).toEqual({
    founding: (baseline.founding as number) + 2,
    standard: (baseline.standard as number) + 1,
  });
  expect((await counts(member)).status).toBe(403);
});