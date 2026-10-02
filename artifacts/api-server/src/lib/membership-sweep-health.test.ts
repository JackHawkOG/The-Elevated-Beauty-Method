import { expect, test, vi } from "vitest";
import type { PoolClient } from "@workspace/db";
import { MembershipSweepHealth } from "./membership-sweep-health";
import { DurableSweepHealthStore, decodeSweepHealth, type HealthBlob, type HealthSnapshot } from "./membership-health-store";

function fixture() {
  let generation = 0;
  let text = "null";
  const blob: HealthBlob = {
    async read(): Promise<HealthSnapshot> {
      return { generation, failure: decodeSweepHealth(text) };
    },
    async write(failure, expected) {
      if (generation !== expected) throw Object.assign(new Error("conflict"), { code: 412 });
      text = JSON.stringify(failure);
      generation++;
    },
  };
  return {
    restart: () => new MembershipSweepHealth(new DurableSweepHealthStore(blob)),
    blob,
    contents: () => text,
  };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 14, minutes));
const client = (query: ReturnType<typeof vi.fn>) => ({ query }) as unknown as PoolClient;

test("brief outages and rapid retries do not alert; three scheduled failures do", async () => {
  const health = fixture().restart();
  await health.failed(undefined, at(0));
  await health.failed(undefined, at(1));
  await health.failed(undefined, at(2));
  expect(health.localWarning()).toBeNull();
  await health.failed(undefined, at(30));
  expect(health.localWarning()).toEqual({
    consecutiveFailures: 4,
    firstFailedAt: at(0).toISOString(),
    lastFailedAt: at(30).toISOString(),
  });
  expect(JSON.stringify(health.localWarning())).not.toMatch(/subscription|invoice|customer|payment|error/i);
});

test("connected failures persist metadata and a restarted tracker reads the warning", async () => {
  const row = { consecutive_failures: 3, first_failed_at: at(0), last_failed_at: at(30) };
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  const health = fixture().restart();
  await health.failed(undefined, at(0));
  await health.failed(undefined, at(15));
  await health.failed(client(query), at(30));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), [3, at(0).toISOString(), at(30).toISOString(), true]);
  expect(health.localWarning()?.consecutiveFailures).toBe(3);
  const restarted = fixture().restart();
  expect(await restarted.warning(client(query))).toEqual(health.localWarning());
});

test("failed persistence retains the warning; completed sweep clears durable and local state", async () => {
  const health = fixture().restart();
  const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
  for (const minutes of [0, 15, 30]) await health.failed(client(query), at(minutes));
  expect(health.localWarning()?.consecutiveFailures).toBe(3);
  await expect(health.healthy(client(query))).rejects.toThrow("database unavailable");
  expect(health.localWarning()).not.toBeNull();
  query.mockResolvedValue({ rows: [] });
  await health.healthy(client(query));
  expect(query).toHaveBeenLastCalledWith("DELETE FROM membership_sweep_health WHERE id = true");
  expect(health.localWarning()).toBeNull();
  await health.failed(undefined, at(45));
  expect(health.localWarning()).toBeNull();
});

test("restart during a database outage recovers the streak before the next failed attempt", async () => {
  const durable = fixture();
  const database = client(vi.fn().mockRejectedValue(new Error("database offline")));
  const first = durable.restart();
  await first.failed(undefined, at(0));
  await first.failed(undefined, at(15));
  expect(first.localWarning()).toBeNull();

  const restarted = durable.restart();
  // Still brief: there has been no third attempt, despite the restart.
  await expect(restarted.warning(database)).rejects.toThrow("database offline");
  expect(restarted.localWarning()).toBeNull();
  await restarted.failed(undefined, at(30));
  expect(restarted.localWarning()).toEqual({
    consecutiveFailures: 3, firstFailedAt: at(0).toISOString(), lastFailedAt: at(30).toISOString(),
  });
  const again = durable.restart();
  await expect(again.warning(database)).rejects.toThrow("database offline");
  expect(again.localWarning()).toEqual(restarted.localWarning());
  expect(Object.keys(JSON.parse(durable.contents())).sort()).toEqual([
    "consecutiveFailures", "firstFailedAt", "lastFailedAt",
  ]);

  await again.healthy(client(vi.fn().mockResolvedValue({ rows: [] })));
  expect(durable.contents()).toBe("null");
  const recovered = durable.restart();
  await expect(recovered.warning(database)).rejects.toThrow("database offline");
  expect(recovered.localWarning()).toBeNull();
  await recovered.failed(undefined, at(45));
  expect(JSON.parse(durable.contents()).consecutiveFailures).toBe(1);
});

test("multiple instances retry conflicting increments without losing an attempt", async () => {
  const durable = fixture();
  await Promise.all([
    durable.restart().failed(undefined, at(0)),
    durable.restart().failed(undefined, at(15)),
    durable.restart().failed(undefined, at(30)),
  ]);
  expect(JSON.parse(durable.contents())).toEqual({
    consecutiveFailures: 3, firstFailedAt: at(0).toISOString(), lastFailedAt: at(30).toISOString(),
  });
});

test("a stale instance observes recovery instead of showing its old local warning", async () => {
  const durable = fixture();
  const old = durable.restart();
  for (const minutes of [0, 15, 30]) await old.failed(undefined, at(minutes));
  await durable.restart().healthy(client(vi.fn().mockResolvedValue({ rows: [] })));
  const offline = client(vi.fn().mockRejectedValue(new Error("database offline")));
  await expect(old.warning(offline)).rejects.toThrow("database offline");
  expect(old.localWarning()).toBeNull();
});

test("invalid or non-operational records are rejected rather than copied", () => {
  for (const value of [
    { consecutiveFailures: 3, firstFailedAt: "bad", lastFailedAt: at(30).toISOString() },
    { consecutiveFailures: -1, firstFailedAt: at(0).toISOString(), lastFailedAt: at(30).toISOString() },
    { consecutiveFailures: 3, firstFailedAt: at(30).toISOString(), lastFailedAt: at(0).toISOString() },
    { consecutiveFailures: 3, firstFailedAt: at(0).toISOString(), lastFailedAt: at(30).toISOString(), customer: "private" },
  ]) expect(() => decodeSweepHealth(JSON.stringify(value))).toThrow("Invalid sweep health record");
});

test("independent storage failure keeps a local warning and does not report a cleared warning", async () => {
  const store = {
    read: vi.fn().mockRejectedValue(new Error("storage offline")),
    update: vi.fn().mockRejectedValue(new Error("storage offline")),
  };
  const health = new MembershipSweepHealth(store);
  for (const minutes of [0, 15, 30]) await health.failed(undefined, at(minutes));
  expect(health.localWarning()?.consecutiveFailures).toBe(3);
  await expect(health.healthy(client(vi.fn().mockResolvedValue({ rows: [] })))).rejects.toThrow("storage offline");
  expect(health.localWarning()).not.toBeNull();
  await expect(health.warning(client(vi.fn().mockRejectedValue(new Error("database offline"))))).rejects.toThrow("database offline");
  expect(health.localWarning()).not.toBeNull();
});