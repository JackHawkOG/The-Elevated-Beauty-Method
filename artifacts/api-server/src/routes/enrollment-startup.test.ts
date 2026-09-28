import { createServer, type Server } from "node:http";
import { afterAll, expect, test, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const repair = vi.hoisted(() => vi.fn<() => Promise<void>>());
const backfill = vi.hoisted(() => vi.fn<(needsPublicationBackfill: boolean) => Promise<void>>());

// Mount the real enrollment route with test authentication. An invalid body
// exercises the route without writing to the development database.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = "startup-test-member";
    next();
  },
}));
vi.mock("../app", async () => {
  const { default: express } = await import("express");
  const { default: enrollmentsRouter } = await import("./enrollments");
  const app = express();
  app.use("/api", express.json(), enrollmentsRouter);
  return { default: app };
});
vi.mock("../lib/ensure-enrollment-schema", () => ({ ensureEnrollmentSchema: repair }));
vi.mock("../lib/ensure-announcement-schema", () => ({ ensureAnnouncementSchema: vi.fn() }));
vi.mock("../lib/ensure-member-stories-schema", () => ({ ensureMemberStoriesSchema: vi.fn() }));
vi.mock("../lib/ensure-progress-schema", () => ({ ensureProgressSchema: vi.fn() }));
vi.mock("../lib/ensure-radiant-audit-schema", () => ({
  ensureRadiantAuditSchema: vi.fn(),
  startRadiantAuditReceiptCleanup: vi.fn(),
  startRadiantAuditDraftPruning: vi.fn(),
}));
vi.mock("../lib/ensure-membership-schema", () => ({ ensureMembershipSchema: vi.fn() }));
vi.mock("../lib/ensure-publication-schema", () => ({ ensurePublicationSchema: vi.fn() }));
vi.mock("../lib/seed-member-journey", () => ({ ensureMemberJourneyContent: backfill }));
vi.mock("../lib/reconcile-announcement-activity", () => ({ reconcileAnnouncementActivity: vi.fn() }));
vi.mock("../lib/membership-reconciliation", () => ({ startMembershipReconciliation: vi.fn() }));
vi.mock("../lib/membership-checkout-expirations", () => ({ startCheckoutExpirationRecovery: vi.fn() }));
vi.mock("../lib/stripeClient", () => ({
  getStripeSync: vi.fn(async () => ({
    findOrCreateManagedWebhook: vi.fn(),
    syncBackfill: vi.fn(),
  })),
}));
vi.mock("stripe-replit-sync", () => ({ runMigrations: vi.fn() }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

let server: Server | undefined;

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
});

test("failed enrollment repair keeps enrollment requests offline; removing fault permits startup", async () => {
  const oldPort = process.env.PORT;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldDomains = process.env.REPLIT_DOMAINS;
  // Reserve a fresh port, then release it for the startup under test.
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));

  process.env.PORT = String(port);
  process.env.DATABASE_URL = "postgres://unused.invalid/test";
  process.env.REPLIT_DOMAINS = "example.invalid";
  try {
    vi.resetModules();
    const { default: failedApp } = await import("../app");
    const failedListen = vi.spyOn(failedApp, "listen");
    let rejectRepair!: (error: Error) => void;
    repair.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRepair = reject;
    }));
    const failedStartup = import("../index");
    // While repair is pending, the endpoint must not be bound.
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(1));
    expect(failedListen).not.toHaveBeenCalled();
    await expect(fetch(`http://127.0.0.1:${port}/api/enrollments`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow();

    rejectRepair(new Error("Injected enrollment repair failure"));
    await expect(failedStartup).rejects.toThrow("Injected enrollment repair failure");
    expect(failedListen).not.toHaveBeenCalled();
    failedListen.mockRestore();

    vi.resetModules();
    repair.mockResolvedValueOnce(undefined);
    const { default: recoveredApp } = await import("../app");
    const recoveredListen = vi.spyOn(recoveredApp, "listen");
    await import("../index");
    expect(repair).toHaveBeenCalledTimes(2);
    expect(recoveredListen).toHaveBeenCalledOnce();
    server = recoveredListen.mock.results[0]?.value as Server;
    expect(server?.listening).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/api/enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    recoveredListen.mockRestore();
  } finally {
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldDomains === undefined) delete process.env.REPLIT_DOMAINS;
    else process.env.REPLIT_DOMAINS = oldDomains;
  }
}, 15000);

test("failed content backfill after enrollment repair keeps enrollment offline; retry starts normally", async () => {
  const oldPort = process.env.PORT;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldDomains = process.env.REPLIT_DOMAINS;
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));

  process.env.PORT = String(port);
  process.env.DATABASE_URL = "postgres://unused.invalid/test";
  process.env.REPLIT_DOMAINS = "example.invalid";
  let recoveredServer: Server | undefined;
  try {
    repair.mockClear();
    backfill.mockClear();
    vi.resetModules();
    const { default: failedApp } = await import("../app");
    const failedListen = vi.spyOn(failedApp, "listen");
    let rejectBackfill!: (error: Error) => void;
    backfill.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectBackfill = reject;
    }));
    const failedStartup = import("../index");
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledOnce());
    expect(repair).toHaveBeenCalledOnce();
    expect(failedListen).not.toHaveBeenCalled();
    await expect(fetch(`http://127.0.0.1:${port}/api/enrollments`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    })).rejects.toThrow();

    rejectBackfill(new Error("Injected content backfill failure"));
    await expect(failedStartup).rejects.toThrow("Injected content backfill failure");
    expect(failedListen).not.toHaveBeenCalled();
    failedListen.mockRestore();

    vi.resetModules();
    backfill.mockResolvedValueOnce(undefined);
    const { default: recoveredApp } = await import("../app");
    const recoveredListen = vi.spyOn(recoveredApp, "listen");
    await import("../index");
    expect(repair).toHaveBeenCalledTimes(2);
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(recoveredListen).toHaveBeenCalledOnce();
    recoveredServer = recoveredListen.mock.results[0]?.value as Server;
    expect(recoveredServer?.listening).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/api/enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    recoveredListen.mockRestore();
  } finally {
    if (recoveredServer?.listening) await new Promise<void>((resolve, reject) => {
      recoveredServer!.close((error) => error ? reject(error) : resolve());
    });
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldDomains === undefined) delete process.env.REPLIT_DOMAINS;
    else process.env.REPLIT_DOMAINS = oldDomains;
  }
}, 15000);