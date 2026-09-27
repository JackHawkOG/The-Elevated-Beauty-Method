import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
import { confirmCheckout } from "../lib/membership-reservations";
import { requireDevelopmentDatabase } from "./test-development-database";

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