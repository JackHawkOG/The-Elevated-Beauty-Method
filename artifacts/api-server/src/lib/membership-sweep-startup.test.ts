import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
import { SWEEP_INITIALIZATION_TIMEOUT_MS } from "./membership-sweep-initialization";

const client = { query: mocks.query, release: mocks.release };
afterEach(() => vi.useRealTimers());
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("hanging connection times out without overlap; late connection is released without queries", async () => {
  vi.useFakeTimers();
  const pending = deferred<typeof client>();
  mocks.connect.mockReturnValueOnce(pending.promise);
  const attempt = expect(reconcileMemberships()).rejects.toThrow("Membership review initialization timed out");
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  await attempt;
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.release).not.toHaveBeenCalled();

  await reconcileMemberships();
  expect(mocks.healthy).toHaveBeenCalledExactlyOnceWith(client);
  const queries = mocks.query.mock.calls.length;
  pending.resolve(client);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.release).toHaveBeenCalledTimes(2);
  expect(mocks.query).toHaveBeenCalledTimes(queries);
  expect(vi.getTimerCount()).toBe(0);
});

test("hanging Stripe initialization unlocks and releases; late success cannot write", async () => {
  vi.useFakeTimers();
  const pending = deferred<object>();
  mocks.stripe.mockReturnValueOnce(pending.promise);
  const attempt = expect(reconcileMemberships()).rejects.toThrow("Membership review initialization timed out");
  await vi.advanceTimersByTimeAsync(0);
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  await attempt;
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(client);
  expect(mocks.healthy).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock(20261001, 56)");
  expect(mocks.release).toHaveBeenCalledOnce();

  await reconcileMemberships();
  expect(mocks.healthy).toHaveBeenCalledExactlyOnceWith(client);
  const queries = mocks.query.mock.calls.length;
  pending.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.query).toHaveBeenCalledTimes(queries);
  expect(mocks.release).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["connection", "Stripe"])("late %s initialization rejection is consumed after recovery", async resource => {
  vi.useFakeTimers();
  const pending = deferred<never>();
  (resource === "connection" ? mocks.connect : mocks.stripe).mockReturnValueOnce(pending.promise);
  const attempt = expect(reconcileMemberships()).rejects.toThrow("Membership review initialization timed out");
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  await attempt;
  await reconcileMemberships();
  pending.reject(new Error("late private provider response"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.failed).toHaveBeenCalledOnce();
  expect(mocks.healthy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("targeted initialization timeout does not change global sweep health", async () => {
  vi.useFakeTimers();
  mocks.stripe.mockReturnValueOnce(new Promise(() => {}));
  const attempt = expect(reconcileMemberships("sub_targeted")).rejects.toThrow("Membership review initialization timed out");
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  await attempt;
  expect(mocks.failed).not.toHaveBeenCalled();
  expect(mocks.healthy).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock(20261001, 56)");
  expect(mocks.release).toHaveBeenCalledOnce();
});

test("a failed unlock after initialization timeout destroys the possibly locked session", async () => {
  vi.useFakeTimers();
  mocks.stripe.mockReturnValueOnce(new Promise(() => {}));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_advisory_unlock")) throw new Error("unlock unavailable");
    return { rows: [{ acquired: true }] };
  });
  const result = expect(reconcileMemberships()).rejects.toThrow("unlock unavailable");
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  await result;
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith(client);
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  mocks.query.mockResolvedValue({ rows: [] });
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledTimes(2);
});

test.each(["connection", "Stripe"])("prolonged hanging %s startup warns generically and recovery clears it", async resource => {
  vi.useFakeTimers();
  const { MembershipSweepHealth } = await vi.importActual<typeof import("./membership-sweep-health")>("./membership-sweep-health");
  let stored: import("./membership-sweep-health").SweepFailure | null = null;
  const health = new MembershipSweepHealth({
    read: async () => stored,
    update: async change => { stored = change(stored); return stored; },
  });
  mocks.failed.mockImplementation((connection?: typeof client) => health.failed(connection));
  mocks.healthy.mockImplementation((connection: typeof client) => health.healthy(connection));
  mocks.warning.mockImplementation(() => health.warning(client));
  mocks.localWarning.mockImplementation(() => health.localWarning());
  const start = Date.UTC(2026, 9, 2, 12);
  vi.setSystemTime(start);
  for (let attempt = 0; attempt < 3; attempt++) {
    vi.setSystemTime(start + attempt * 15 * 60_000);
    (resource === "connection" ? mocks.connect : mocks.stripe).mockReturnValueOnce(new Promise(() => {}));
    const result = expect(reconcileMemberships()).rejects.toThrow("Membership review initialization timed out");
    await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
    await result;
    const alerts = await unresolvedReconciliationAlerts();
    if (attempt < 2) expect(alerts.sweepFailure).toBeNull();
    else {
      expect(alerts.sweepFailure).toEqual({
        consecutiveFailures: 3,
        firstFailedAt: new Date(start + SWEEP_INITIALIZATION_TIMEOUT_MS).toISOString(),
        lastFailedAt: new Date(start + 30 * 60_000 + SWEEP_INITIALIZATION_TIMEOUT_MS).toISOString(),
      });
      expect(Object.keys(alerts.sweepFailure!).sort()).toEqual([
        "consecutiveFailures", "firstFailedAt", "lastFailedAt",
      ]);
    }
  }
  // Staff can still read the warning if the database lookup hangs rather
  // than rejects. The independent health store remains available.
  mocks.query.mockReturnValueOnce(new Promise(() => {}));
  const degradedAlerts = unresolvedReconciliationAlerts();
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  expect(await degradedAlerts).toEqual({
    total: 0, subscriptions: [], subscriptionsAvailable: false,
    sweepFailure: health.localWarning(),
  });
  await reconcileMemberships();
  expect(stored).toBeNull();
  expect((await unresolvedReconciliationAlerts()).sweepFailure).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["lock", "batch", "unlock"])("a stalled %s operation warns without overlap or early session release", async operation => {
  vi.useFakeTimers();
  const { MembershipSweepHealth } = await vi.importActual<typeof import("./membership-sweep-health")>("./membership-sweep-health");
  let stored: import("./membership-sweep-health").SweepFailure | null = null;
  const health = new MembershipSweepHealth({
    read: async () => stored,
    update: async change => { stored = change(stored); return stored; },
  });
  mocks.failed.mockImplementation((connection?: typeof client) => health.failed(connection));
  mocks.healthy.mockImplementation((connection: typeof client) => health.healthy(connection));
  mocks.warning.mockImplementation(() => health.warning(client));
  mocks.localWarning.mockImplementation(() => health.localWarning());
  const blocked = deferred<{ rows: object[] }>();
  let blockedOnce = false;
  mocks.query.mockImplementation(async (sql: string) => {
    const target = operation === "lock" ? "pg_try_advisory_lock"
      : operation === "unlock" ? "pg_advisory_unlock" : "ORDER BY id LIMIT 100";
    if (!blockedOnce && sql.includes(target)) {
      blockedOnce = true;
      return blocked.promise;
    }
    return { rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [] };
  });
  const sweep = reconcileMemberships();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(health.localWarning()).toBeNull();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(health.localWarning()?.consecutiveFailures).toBe(3);
  expect(mocks.failed.mock.calls).toEqual([[undefined], [undefined], [undefined]]);
  expect((await unresolvedReconciliationAlerts()).sweepFailure).toEqual(health.localWarning());
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.release).not.toHaveBeenCalled();
  if (operation !== "unlock") {
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(false);
  }
  expect(mocks.healthy).not.toHaveBeenCalled();

  blocked.resolve({ rows: operation === "lock" ? [{ acquired: true }] : [] });
  await sweep;
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock(20261001, 56)");
  expect((await unresolvedReconciliationAlerts()).sweepFailure).toBeNull();
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("a hanging subscription-alert SELECT still returns the known private sweep warning", async () => {
  vi.useFakeTimers();
  const warning = {
    consecutiveFailures: 3, firstFailedAt: "2026-10-02T12:00:00Z", lastFailedAt: "2026-10-02T12:30:00Z",
  };
  mocks.warning.mockResolvedValue(warning);
  mocks.localWarning.mockReturnValue(warning);
  const blocked = deferred<{ rows: object[] }>();
  mocks.query.mockReturnValueOnce(blocked.promise);
  const alerts = unresolvedReconciliationAlerts();
  await vi.advanceTimersByTimeAsync(SWEEP_INITIALIZATION_TIMEOUT_MS);
  expect(await alerts).toEqual({
    total: 0, subscriptions: [], subscriptionsAvailable: false, sweepFailure: warning,
  });
  blocked.resolve({ rows: [{ subscription_id: "private-late-subscription" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.healthy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("recovery drains an already-dispatched stall observation before clearing health", async () => {
  vi.useFakeTimers();
  const blocked = deferred<{ rows: object[] }>();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("ORDER BY id LIMIT 100")) return blocked.promise;
    return { rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [] };
  });
  const observation = deferred<void>();
  mocks.failed.mockReturnValueOnce(observation.promise);
  const sweep = reconcileMemberships();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  blocked.resolve({ rows: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.healthy).not.toHaveBeenCalled();
  expect(mocks.release).not.toHaveBeenCalled();
  await reconcileMemberships();
  expect(mocks.connect).toHaveBeenCalledOnce();
  observation.resolve();
  await sweep;
  expect(mocks.healthy).toHaveBeenCalledExactlyOnceWith(client);
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});