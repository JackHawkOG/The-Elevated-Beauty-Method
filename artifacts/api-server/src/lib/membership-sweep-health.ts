import type { PoolClient } from "@workspace/db";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export type SweepFailure = {
  consecutiveFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
};

// Three scheduled attempts span at least half an hour. Rapid manual retries
// must not turn a brief outage into a persistent-outage warning.
const MIN_OUTAGE_MS = 30 * 60_000;
type Queryable = Pick<PoolClient, "query">;
type StoredFailure = { consecutive_failures: number; first_failed_at: Date; last_failed_at: Date };

function fromRow(row: StoredFailure): SweepFailure {
  return {
    consecutiveFailures: row.consecutive_failures,
    firstFailedAt: row.first_failed_at.toISOString(),
    lastFailedAt: row.last_failed_at.toISOString(),
  };
}

export class MembershipSweepHealth {
  private failure: SweepFailure | null = null;

  async failed(client?: Queryable, now = new Date()): Promise<void> {
    this.failure = {
      consecutiveFailures: (this.failure?.consecutiveFailures ?? 0) + 1,
      firstFailedAt: this.failure?.firstFailedAt ?? now.toISOString(),
      lastFailedAt: now.toISOString(),
    };
    // A database outage cannot record itself in that database. Retain the
    // operational state locally until a connected sweep can persist it.
    if (!client) return;
    try {
      const result = await client.query<StoredFailure>(`
        INSERT INTO membership_sweep_health (id, consecutive_failures, first_failed_at, last_failed_at)
        VALUES (true, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          consecutive_failures = GREATEST(membership_sweep_health.consecutive_failures + 1, $1),
          first_failed_at = LEAST(membership_sweep_health.first_failed_at, $2),
          last_failed_at = GREATEST(membership_sweep_health.last_failed_at, $3)
        RETURNING consecutive_failures, first_failed_at, last_failed_at`,
      [this.failure.consecutiveFailures, this.failure.firstFailedAt, this.failure.lastFailedAt]);
      this.failure = fromRow(result.rows[0]);
    } catch (err) {
      logger.error({ err }, "Could not persist membership sweep health");
    }
  }

  async healthy(client: Queryable): Promise<void> {
    // Clear local state only once the durable warning has been cleared too.
    await client.query("DELETE FROM membership_sweep_health WHERE id = true");
    this.failure = null;
  }

  localWarning(): SweepFailure | null {
    const failure = this.failure;
    return failure && failure.consecutiveFailures >= 3 &&
      Date.parse(failure.lastFailedAt) - Date.parse(failure.firstFailedAt) >= MIN_OUTAGE_MS
      ? { ...failure } : null;
  }

  async warning(client: Queryable = pool): Promise<SweepFailure | null> {
    const result = await client.query<StoredFailure>(
      "SELECT consecutive_failures, first_failed_at, last_failed_at FROM membership_sweep_health WHERE id = true",
    );
    const row = result.rows[0];
    const stored = row ? fromRow(row) : null;
    const local = this.localWarning();
    if (local) return local;
    return stored && stored.consecutiveFailures >= 3 &&
      Date.parse(stored.lastFailedAt) - Date.parse(stored.firstFailedAt) >= MIN_OUTAGE_MS
      ? stored : null;
  }
}

export const membershipSweepHealth = new MembershipSweepHealth();