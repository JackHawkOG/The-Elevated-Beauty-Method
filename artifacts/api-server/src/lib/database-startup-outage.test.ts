import express from "express";
import type { Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  text: "null",
  query: vi.fn(),
  connect: vi.fn(),
  read: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = { query: mocks.query, connect: mocks.connect };
  return {
    ...actual,
    pool,
    // Use the real Drizzle session, not a hand-constructed wrapper. Reject
    // only its driver query so ensureProfileSchema follows the actual path.
    db: drizzle(pool as unknown as typeof actual.pool),
  };
});
vi.mock("./membership-health-store", () => ({
  independentSweepHealthStore: {
    async read() { mocks.read(); return JSON.parse(mocks.text); },
    async update(change: (value: unknown) => unknown) {
      mocks.text = JSON.stringify(change(JSON.parse(mocks.text)));
      return JSON.parse(mocks.text);
    },
  },
}));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-role") ?? null }),
  clerkClient: { users: { getUser: mocks.getUser } },
}));

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
  server = undefined;
  vi.useRealTimers();
  vi.resetModules();
});
const offline = () => Object.assign(new Error("database offline"), { code: "ECONNREFUSED" });

test("real schema initialization wrapping an offline driver serves recovered warnings only to verified staff after restart", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mocks.text = "null";
  mocks.query.mockRejectedValue(offline());
  mocks.query.mockClear();
  mocks.connect.mockRejectedValue(offline());
  mocks.read.mockClear();
  mocks.getUser.mockImplementation(async (role: string) => ({ publicMetadata: { role } }));
  let profile = await import("./ensure-profile-schema");
  const failStartup = () => profile.ensureProfileSchema();
  await expect(failStartup()).rejects.toBeInstanceOf(DrizzleQueryError);

  let startup = await import("./database-startup-outage");
  for (const minutes of [0, 15]) {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 14, minutes)));
    expect(await startup.tryDatabaseStartup(failStartup)).toBe(false);
  }
  // Lose all tracker and startup-module memory, but preserve the independent
  // serialized operational record. The application database stays unreachable.
  vi.resetModules();
  profile = await import("./ensure-profile-schema");
  startup = await import("./database-startup-outage");
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 14, 30)));
  expect(await startup.tryDatabaseStartup(failStartup)).toBe(false);
  expect(mocks.query.mock.calls.filter(args => args[0] === "SELECT 1")).toHaveLength(3);
  expect(JSON.parse(mocks.text).consecutiveFailures).toBe(3);
  const { default: membershipRouter } = await import("../routes/membership");
  const app = express();
  app.use(startup.databaseStartupGuard);
  app.use((req, _res, next) => {
    req.log = { error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  app.use("/api", membershipRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}`;

  for (const role of ["owner", "admin"]) {
    const response = await fetch(`${url}/api/membership/reconciliation-alerts`, { headers: { "x-test-role": role } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      total: 0, subscriptions: [], subscriptionsAvailable: false,
      sweepFailure: {
        consecutiveFailures: 3,
        firstFailedAt: "2026-10-01T14:00:00.000Z",
        lastFailedAt: "2026-10-01T14:30:00.000Z",
      },
    });
  }
  const reads = mocks.read.mock.calls.length;
  for (const [role, status] of [["member", 403], ["", 401]] as const) {
    const response = await fetch(`${url}/api/membership/reconciliation-alerts`, { headers: { "x-test-role": role } });
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("sweepFailure");
  }
  mocks.getUser.mockRejectedValueOnce(new Error("Identity service offline"));
  const denied = await fetch(`${url}/api/membership/reconciliation-alerts`, { headers: { "x-test-role": "owner" } });
  expect(denied.status).toBe(503);
  expect(await denied.json()).not.toHaveProperty("sweepFailure");
  expect(mocks.read).toHaveBeenCalledTimes(reads);
  const beforeQueries = mocks.query.mock.calls.length;
  for (const path of ["/api/membership", "/api/stripe/webhook", "/api/membership/reconciliation-alerts"]) {
    expect((await fetch(`${url}${path}`, { method: "POST" })).status).toBe(503);
  }
  expect(mocks.query).toHaveBeenCalledTimes(beforeQueries);
  expect(await (await fetch(`${url}/api/healthz`)).json()).toEqual({ status: "degraded", databaseAvailable: false });

  // Startup recovery opens the normal routes, but only a completed sweep
  // clears the independently persisted warning.
  mocks.query.mockResolvedValue({ rows: [] });
  expect(await startup.tryDatabaseStartup(async () => {})).toBe(true);
  const { membershipSweepHealth } = await import("./membership-sweep-health");
  expect(membershipSweepHealth.localWarning()).not.toBeNull();
  await membershipSweepHealth.healthy({ query: mocks.query });
  expect(mocks.text).toBe("null");
  const response = await fetch(`${url}/api/membership/reconciliation-alerts`, { headers: { "x-test-role": "owner" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ total: 0, subscriptions: [], subscriptionsAvailable: true, sweepFailure: null });
});

test("schema errors and non-database network failures remain fatal", async () => {
  const { tryDatabaseStartup } = await import("./database-startup-outage");
  mocks.text = "null";
  mocks.query.mockResolvedValue({ rows: [] });
  const schemaError = Object.assign(new Error("incompatible index"), { code: "42P07" });
  await expect(tryDatabaseStartup(async () => { throw schemaError; })).rejects.toBe(schemaError);
  // The same real Drizzle wrapper must not make a schema error recoverable.
  mocks.query.mockRejectedValue(schemaError);
  const { ensureProfileSchema } = await import("./ensure-profile-schema");
  await expect(tryDatabaseStartup(ensureProfileSchema)).rejects.toMatchObject({ cause: schemaError });
  mocks.query.mockResolvedValue({ rows: [] });
  const stripeError = offline();
  await expect(tryDatabaseStartup(async () => { throw stripeError; })).rejects.toBe(stripeError);
  expect(mocks.text).toBe("null");
});

test("trusted nested wrappers are classified without following arbitrary or cyclic causes", async () => {
  const { isDatabaseConnectionFailure } = await import("./database-startup-outage");
  expect(isDatabaseConnectionFailure(new DrizzleQueryError("test", [], new AggregateError([offline()])))).toBe(true);
  expect(isDatabaseConnectionFailure(new Error("application error", { cause: offline() }))).toBe(false);
  const cyclic = new DrizzleQueryError("test", []);
  cyclic.cause = cyclic;
  expect(isDatabaseConnectionFailure(cyclic)).toBe(false);
});