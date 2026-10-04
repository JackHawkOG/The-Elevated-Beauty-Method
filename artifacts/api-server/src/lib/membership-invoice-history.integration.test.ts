import { expect, test, vi } from "vitest";
import { pool } from "@workspace/db";
import { requireDevelopmentDatabase } from "../routes/test-development-database";
import { membershipInvoiceHistoryNotice, pendingMembershipInvoiceHistory } from "./membership-invoice-history";

test("pending queue filters real SQL to ended founding records and leaves recovery state unchanged", async () => {
  requireDevelopmentDatabase();
  const client = await pool.connect();
  let querySpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await client.query("BEGIN");
    // Transaction-local fixtures never write to the shared membership table.
    await client.query(`CREATE TEMP TABLE membership_checkouts (
      id integer, clerk_id text, kind text, status text, stripe_subscription_id text,
      invoice_history_pending boolean, invoice_history_retry_count integer, invoice_history_retry_at timestamptz
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO membership_checkouts VALUES
      (1, 'ended-pending', 'founding', 'forfeited', 'sub_pending', true, 3, '2026-10-03T12:00:00Z'),
      (2, 'ended-recovered', 'founding', 'forfeited', 'sub_recovered', false, 0, NULL),
      (3, 'active', 'founding', 'confirmed', 'sub_active', true, 1, now()),
      (4, 'standard', 'standard', 'forfeited', 'sub_standard', true, 2, now()),
      (5, 'reservation', 'founding', 'pending', 'sub_reservation', true, 1, now()),
      (6, 'missing-schedule', 'founding', 'forfeited', NULL, true, 2, NULL)`);
    const before = (await client.query("SELECT * FROM membership_checkouts ORDER BY id")).rows;
    querySpy = vi.spyOn(pool, "query").mockImplementation(((sql: string, params?: unknown[]) => client.query(sql, params)) as typeof pool.query);
    expect(await pendingMembershipInvoiceHistory()).toEqual({
      memberships: [
        { checkoutId: 1, memberId: "ended-pending", subscriptionId: "sub_pending", retryAttempts: 3, nextRetryAt: "2026-10-03T12:00:00.000Z" },
        { checkoutId: 6, memberId: "missing-schedule", subscriptionId: null, retryAttempts: 2, nextRetryAt: null },
      ],
      nextCursor: null,
    });
    expect((await pendingMembershipInvoiceHistory(1)).memberships.map(row => row.checkoutId)).toEqual([6]);
    expect((await client.query("SELECT * FROM membership_checkouts ORDER BY id")).rows).toEqual(before);
    await client.query("UPDATE membership_checkouts SET invoice_history_pending = false WHERE id = 1");
    expect((await pendingMembershipInvoiceHistory()).memberships.map(row => row.checkoutId)).toEqual([6]);
  } finally {
    querySpy?.mockRestore();
    await client.query("ROLLBACK");
    client.release();
  }
});

test("notice threshold excludes unrelated records and clears only with committed history recovery", async () => {
  requireDevelopmentDatabase();
  const client = await pool.connect();
  let querySpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE membership_checkouts (
      id integer, kind text, status text, invoice_history_pending boolean,
      invoice_history_retry_count integer, invoice_history_retry_at timestamptz
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO membership_checkouts VALUES
      (1, 'founding', 'forfeited', true, 7, now()),
      (2, 'founding', 'forfeited', true, 8, now() + interval '1 day'),
      (3, 'founding', 'forfeited', true, 9, NULL),
      (4, 'founding', 'forfeited', false, 100, NULL),
      (5, 'founding', 'confirmed', true, 100, NULL),
      (6, 'standard', 'forfeited', true, 100, NULL),
      (7, 'founding', 'pending', true, 100, NULL)`);
    const before = (await client.query("SELECT * FROM membership_checkouts ORDER BY id")).rows;
    querySpy = vi.spyOn(pool, "query").mockImplementation(((sql: string, params?: unknown[]) => client.query(sql, params)) as typeof pool.query);
    expect(await membershipInvoiceHistoryNotice()).toEqual({ overdueCount: 2, failedAttemptThreshold: 8 });
    expect((await client.query("SELECT * FROM membership_checkouts ORDER BY id")).rows).toEqual(before);
    await client.query("SAVEPOINT recovery");
    await client.query("UPDATE membership_checkouts SET invoice_history_pending = false, invoice_history_retry_count = 0 WHERE id IN (2, 3)");
    expect((await membershipInvoiceHistoryNotice()).overdueCount).toBe(0);
    await client.query("ROLLBACK TO SAVEPOINT recovery");
    expect((await membershipInvoiceHistoryNotice()).overdueCount).toBe(2);
    await client.query("UPDATE membership_checkouts SET invoice_history_pending = false, invoice_history_retry_count = 0 WHERE id IN (2, 3)");
    expect((await membershipInvoiceHistoryNotice()).overdueCount).toBe(0);
    expect((await client.query("SELECT status FROM membership_checkouts WHERE id IN (2, 3)")).rows)
      .toEqual([{ status: "forfeited" }, { status: "forfeited" }]);
  } finally {
    querySpy?.mockRestore();
    await client.query("ROLLBACK");
    client.release();
  }
});