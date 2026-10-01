import { expect, test, vi } from "vitest";
import type { PoolClient } from "@workspace/db";
import { MembershipSweepHealth } from "./membership-sweep-health";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 14, minutes));
const client = (query: ReturnType<typeof vi.fn>) => ({ query }) as unknown as PoolClient;

test("brief outages and rapid retries do not alert; three scheduled failures do", async () => {
  const health = new MembershipSweepHealth();
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
  const health = new MembershipSweepHealth();
  await health.failed(client(query), at(30));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), [1, at(30).toISOString(), at(30).toISOString()]);
  expect(health.localWarning()?.consecutiveFailures).toBe(3);
  const restarted = new MembershipSweepHealth();
  expect(await restarted.warning(client(query))).toEqual(health.localWarning());
});

test("failed persistence retains the warning; completed sweep clears durable and local state", async () => {
  const health = new MembershipSweepHealth();
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