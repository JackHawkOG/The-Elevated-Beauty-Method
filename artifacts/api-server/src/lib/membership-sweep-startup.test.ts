import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), release: vi.fn(), stripe: vi.fn(),
  failed: vi.fn(), healthy: vi.fn(), warning: vi.fn(), localWarning: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { connect: mocks.connect, query: mocks.query } }));
vi.mock("./stripeClient", () => ({ getUncachableStripeClient: mocks.stripe }));
vi.mock("./membership-sweep-health", () => ({
  membershipSweepHealth: {
    failed: mocks.failed, healthy: mocks.healthy, warning: mocks.warning, localWarning: mocks.localWarning,
  },
}));
import { reconcileMemberships, unresolvedReconciliationAlerts } from "./membership-reconciliation";

const client = { query: mocks.query, release: mocks.release };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(client);
  mocks.stripe.mockResolvedValue({});
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [],
  }));
  mocks.warning.mockResolvedValue(null);
  mocks.localWarning.mockReturnValue(null);
});

test("connection failure is tracked even though no subscription can be reached", async () => {
  const err = new Error("offline");
  mocks.connect.mockRejectedValue(err);
  await expect(reconcileMemberships()).rejects.toBe(err);
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mocks.healthy).not.toHaveBeenCalled();
  expect(mocks.stripe).not.toHaveBeenCalled();
});

test("shared Stripe startup failure is tracked once, unlocks and releases", async () => {
  mocks.stripe.mockRejectedValue(new Error("Stripe unavailable"));
  await expect(reconcileMemberships()).rejects.toThrow("Stripe unavailable");
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(client);
  expect(mocks.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock(20261001, 56)");
  expect(mocks.release).toHaveBeenCalledOnce();
});

test("lock query failure is tracked but contention does not alert or clear warnings", async () => {
  mocks.query.mockRejectedValueOnce(new Error("database offline"));
  await expect(reconcileMemberships()).rejects.toThrow("database offline");
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(client);
  mocks.failed.mockClear();
  mocks.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
  await reconcileMemberships();
  expect(mocks.failed).not.toHaveBeenCalled();
  expect(mocks.healthy).not.toHaveBeenCalled();
});

test("failure reading the first batch is global; a completed empty sweep clears it", async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ acquired: true }] })
    .mockRejectedValueOnce(new Error("cannot list subscriptions"));
  await expect(reconcileMemberships()).rejects.toThrow("cannot list subscriptions");
  expect(mocks.failed).toHaveBeenCalledOnce();
  expect(mocks.healthy).not.toHaveBeenCalled();
  await reconcileMemberships();
  expect(mocks.healthy).toHaveBeenCalledExactlyOnceWith(client);
});

test("targeted retries neither advance nor resolve full-sweep health", async () => {
  mocks.stripe.mockRejectedValueOnce(new Error("targeted failure"));
  await expect(reconcileMemberships("sub_targeted")).rejects.toThrow("targeted failure");
  await reconcileMemberships("sub_targeted");
  expect(mocks.failed).not.toHaveBeenCalled();
  expect(mocks.healthy).not.toHaveBeenCalled();
});

test("known prolonged outage remains readable without database; unknown failure is explicit", async () => {
  const warning = { consecutiveFailures: 3, firstFailedAt: "2026-10-01T14:00:00Z", lastFailedAt: "2026-10-01T14:30:00Z" };
  mocks.warning.mockRejectedValue(new Error("database offline"));
  mocks.localWarning.mockReturnValue(warning);
  expect(await unresolvedReconciliationAlerts()).toEqual({
    total: 0, subscriptions: [], subscriptionsAvailable: false, sweepFailure: warning,
  });
  mocks.localWarning.mockReturnValue(null);
  await expect(unresolvedReconciliationAlerts()).rejects.toThrow("database offline");
});