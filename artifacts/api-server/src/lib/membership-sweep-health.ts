import type { PoolClient } from "@workspace/db";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { independentSweepHealthStore, type SweepHealthStore } from "./membership-health-store";
import { initializeSweepResource } from "./membership-sweep-initialization";

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
  constructor(private readonly store: SweepHealthStore = independentSweepHealthStore) {}

  async failed(client?: Queryable, now = new Date()): Promise<void> {
    let independentSaved = false;
    const advance = (failure: SweepFailure | null): SweepFailure => ({
      consecutiveFailures: (failure?.consecutiveFailures ?? 0) + 1,
      firstFailedAt: new Date(Math.min(Date.parse(failure?.firstFailedAt ?? now.toISOString()), now.getTime())).toISOString(),
      lastFailedAt: new Date(Math.max(Date.parse(failure?.lastFailedAt ?? now.toISOString()), now.getTime())).toISOString(),
    });
    try {
      const saved = await this.store.update(advance);
      if (!saved) throw new Error("Failed attempt was not retained");
      this.failure = saved;
      independentSaved = true;
    } catch {
      this.failure = advance(this.failure);
      // Do not log provider responses, credentials, or arbitrary error data.
      logger.error("Independent membership sweep health storage unavailable; retaining local failure");
    }
    if (!client) return;
    try {
      const result = await client.query<StoredFailure>(`
        INSERT INTO membership_sweep_health (id, consecutive_failures, first_failed_at, last_failed_at)
        VALUES (true, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          consecutive_failures = GREATEST(membership_sweep_health.consecutive_failures + CASE WHEN $4 THEN 0 ELSE 1 END, $1),
          first_failed_at = LEAST(membership_sweep_health.first_failed_at, $2),
          last_failed_at = GREATEST(membership_sweep_health.last_failed_at, $3)
        RETURNING consecutive_failures, first_failed_at, last_failed_at`,
      [this.failure.consecutiveFailures, this.failure.firstFailedAt, this.failure.lastFailedAt, independentSaved]);
      // The independent record is authoritative while available. Do not write
      // a delayed database response back over a newer independent recovery.
      // Database-only metadata remains a fallback if independent storage fails.
      if (!independentSaved) this.failure = fromRow(result.rows[0]);
    } catch {
      logger.error("Could not synchronize membership sweep health");
    }
  }

  async healthy(client: Queryable): Promise<void> {
    // Clear local state only once the durable warning has been cleared too.
    await client.query("DELETE FROM membership_sweep_health WHERE id = true");
    // A null tombstone participates in generation checks, so concurrent
    // failed attempts cannot overwrite a recovery using an old snapshot.
    await this.store.update(() => null);
    this.failure = null;
  }

  localWarning(): SweepFailure | null {
    const failure = this.failure;
    return failure && failure.consecutiveFailures >= 3 &&
      Date.parse(failure.lastFailedAt) - Date.parse(failure.firstFailedAt) >= MIN_OUTAGE_MS
      ? { ...failure } : null;
  }

  async warning(client: Queryable = pool): Promise<SweepFailure | null> {
    try {
      this.failure = await this.store.read();
    } catch {
      logger.error("Could not read independent membership sweep health");
    }
    // This read-only lookup can also wait forever for a pooled connection.
    // A deadline lets callers use the independent warning; unlike a lock or
    // write, a late SELECT cannot change membership state or leak a lock.
    const result = await initializeSweepResource(client.query<StoredFailure>(
      "SELECT consecutive_failures, first_failed_at, last_failed_at FROM membership_sweep_health WHERE id = true",
    ));
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