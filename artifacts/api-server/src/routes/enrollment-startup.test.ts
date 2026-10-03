import { createServer, type Server } from "node:http";
import { afterAll, expect, test, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const repair = vi.hoisted(() => vi.fn<() => Promise<void>>());
const backfill = vi.hoisted(() => vi.fn<(needsPublicationBackfill: boolean) => Promise<void>>());
const stripeStages = vi.hoisted(() => ({
  migrations: vi.fn<(...args: unknown[]) => Promise<void>>(),
  connection: vi.fn<() => Promise<void>>(),
  webhook: vi.fn<(...args: unknown[]) => Promise<void>>(),
  synchronization: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

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
vi.mock("../lib/ensure-profile-schema", () => ({ ensureProfileSchema: vi.fn() }));
vi.mock("../lib/ensure-routine-guide-schema", () => ({
  ensureRoutineGuideSchema: vi.fn(),
  startRoutineGuideRateLimitCleanup: vi.fn(),
}));
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
vi.mock("../lib/membership-review-email", () => ({ startMembershipReviewEmails: vi.fn() }));
vi.mock("../lib/membership-checkout-expirations", () => ({ startCheckoutExpirationRecovery: vi.fn() }));
vi.mock("../lib/membership-orphan-recovery", () => ({ startMembershipOrphanRecovery: vi.fn() }));
vi.mock("../lib/membership-paid-recovery", () => ({ startUntrackedPaidCheckoutRecovery: vi.fn() }));
vi.mock("../lib/stripeClient", () => ({
  getStripeSync: async () => {
    await stripeStages.connection();
    return {
      findOrCreateManagedWebhook: stripeStages.webhook,
      syncBackfill: stripeStages.synchronization,
    };
  },
}));
vi.mock("stripe-replit-sync", () => ({ runMigrations: stripeStages.migrations }));
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
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(1), { timeout: 10000 });
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
}, 30000);

test.each(["migrations", "connection", "webhook", "synchronization"] as const)(
  "Stripe %s blocks enrollment while pending and after failure; a clean retry starts normally",
  async (stage) => {
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
    const listenSpies: ReturnType<typeof vi.spyOn>[] = [];
    let rejectStage: ((error: Error) => void) | undefined;
    let failedStartup: Promise<unknown> | undefined;
    const expectEnrollmentOffline = async () => {
      await expect(fetch(`http://127.0.0.1:${port}/api/enrollments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1000),
      })).rejects.toThrow();
    };
    try {
      repair.mockClear();
      backfill.mockClear();
      for (const mock of Object.values(stripeStages)) mock.mockReset().mockResolvedValue(undefined);
      vi.resetModules();
      const { default: failedApp } = await import("../app");
      const failedListen = vi.spyOn(failedApp, "listen");
      listenSpies.push(failedListen);
      stripeStages[stage].mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectStage = reject;
      }));
      failedStartup = import("../index");
      // Attach a handler immediately so even an unexpectedly early failure is handled.
      void failedStartup.catch(() => {});
      await vi.waitFor(() => expect(stripeStages[stage]).toHaveBeenCalledOnce());
      expect(repair).toHaveBeenCalledOnce();
      expect(backfill).toHaveBeenCalledOnce();
      expect(failedListen).not.toHaveBeenCalled();
      await expectEnrollmentOffline();
      const laterStages = Object.keys(stripeStages).slice(
        Object.keys(stripeStages).indexOf(stage) + 1,
      ) as (keyof typeof stripeStages)[];
      for (const later of laterStages) expect(stripeStages[later]).not.toHaveBeenCalled();

      const failureMessage = `Injected Stripe ${stage} failure`;
      rejectStage!(new Error(failureMessage));
      await expect(failedStartup).rejects.toThrow(failureMessage);
      expect(failedListen).not.toHaveBeenCalled();
      await expectEnrollmentOffline();
      for (const later of laterStages) expect(stripeStages[later]).not.toHaveBeenCalled();

      vi.resetModules();
      const { default: recoveredApp } = await import("../app");
      const recoveredListen = vi.spyOn(recoveredApp, "listen");
      listenSpies.push(recoveredListen);
      await import("../index");
      expect(repair).toHaveBeenCalledTimes(2);
      expect(backfill).toHaveBeenCalledTimes(2);
      expect(recoveredListen).toHaveBeenCalledOnce();
      const recoveredServer = recoveredListen.mock.results[0]?.value as Server;
      expect(recoveredServer.listening).toBe(true);
      for (const [name, mock] of Object.entries(stripeStages)) {
        expect(mock).toHaveBeenCalledTimes(laterStages.includes(name as keyof typeof stripeStages) ? 1 : 2);
        expect(mock.mock.invocationCallOrder.at(-1)).toBeLessThan(
          recoveredListen.mock.invocationCallOrder[0],
        );
      }
      expect(stripeStages.migrations).toHaveBeenLastCalledWith({ databaseUrl: "postgres://unused.invalid/test" });
      expect(stripeStages.connection).toHaveBeenLastCalledWith();
      const completedStages = Object.values(stripeStages);
      for (let index = 1; index < completedStages.length; index++) {
        expect(completedStages[index - 1].mock.invocationCallOrder.at(-1)).toBeLessThan(
          completedStages[index].mock.invocationCallOrder.at(-1)!,
        );
      }
      expect(stripeStages.webhook).toHaveBeenLastCalledWith("https://example.invalid/api/stripe/webhook");
      expect(stripeStages.synchronization).toHaveBeenLastCalledWith({ object: "all" });
      const response = await fetch(`http://127.0.0.1:${port}/api/enrollments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1000),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    } finally {
      // Also release a pending stage or an early-bound server if an ordering regression fails the test.
      try {
        rejectStage?.(new Error("Startup test cleanup"));
        await failedStartup?.catch(() => {});
        const servers: Server[] = [];
        for (const spy of listenSpies) {
          for (const result of spy.mock.results) {
            if (result.type === "return") servers.push(result.value as Server);
          }
        }
        const closed = await Promise.allSettled(servers.map(async listeningServer => {
          if (!listeningServer.listening) return;
          listeningServer.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            listeningServer.close(error => error ? reject(error) : resolve());
          });
        }));
        const failures = closed.filter(result => result.status === "rejected");
        if (failures.length) {
          throw new AggregateError(failures.map(result => result.reason), "Startup listener cleanup failed");
        }
      } finally {
        for (const spy of listenSpies) spy.mockRestore();
        for (const mock of Object.values(stripeStages)) mock.mockReset();
        if (oldPort === undefined) delete process.env.PORT;
        else process.env.PORT = oldPort;
        if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = oldDatabaseUrl;
        if (oldDomains === undefined) delete process.env.REPLIT_DOMAINS;
        else process.env.REPLIT_DOMAINS = oldDomains;
      }
    }
  },
  30000,
);

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
}, 30000);