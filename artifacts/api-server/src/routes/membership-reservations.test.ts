import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
import {
  FOUNDING_LIMIT, lockMembershipCapacity, hasFoundingCapacity, confirmCheckout, expireCheckout, checkoutExpiry,
} from "../lib/membership-reservations";

const prefix = `founder-test-${randomUUID()}`;
const generated: string[] = [];
let fixtureLock: PoolClient | undefined;

test("Checkout expiry leaves a margin above Stripe's 30-minute minimum", () => {
  const startedAt = Date.now();
  // Even after a minute spent contacting Stripe, the session still has
  // more than Stripe's minimum 30 minutes remaining at receipt.
  expect(checkoutExpiry(startedAt) - Math.ceil((startedAt + 60_000) / 1000)).toBeGreaterThan(1800);
});

afterAll(async () => {
  try {
    if (generated.length) {
      await pool.query("DELETE FROM membership_checkouts WHERE clerk_id = ANY($1::text[])", [generated]);
      await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [generated]);
    }
  } finally {
    if (fixtureLock) {
      await fixtureLock.query("SELECT pg_advisory_unlock(20261001, 55)");
      fixtureLock.release();
    }
  }
});

test("the final place can be reserved once; expiration releases it but confirmed or forfeited places never return", async () => {
  // This integration test may only mutate the workspace's development database.
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT ||
      !process.env.PGHOST || !process.env.PGPORT || !process.env.PGDATABASE || !process.env.PGUSER) {
    throw new Error("Founding capacity test requires the development database");
  }
  const target = new URL(process.env.DATABASE_URL || "");
  if (target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE ||
      decodeURIComponent(target.username) !== process.env.PGUSER) {
    throw new Error("Founding capacity test cannot run against a different database");
  }
  // Hold the same test-only lock as the HTTP flow suite until fixture cleanup.
  fixtureLock = await pool.connect();
  await fixtureLock.query("SELECT pg_advisory_lock(20261001, 55)");
  await ensureMembershipSchema();
  const existing = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM membership_checkouts WHERE kind = 'founding' AND status IN ('pending', 'confirmed', 'forfeited')",
  );
  const fill = FOUNDING_LIMIT - 1 - Number(existing.rows[0].count);
  if (fill < 0) throw new Error("Development database already has all founding places reserved");
  generated.push(...Array.from({ length: fill + 3 }, (_, i) => `${prefix}-${i}`));
  for (const id of generated) {
    await pool.query(
      "INSERT INTO users (clerk_id, display_name, email) VALUES ($1, $1, $2)",
      [id, `${id}@example.invalid`],
    );
  }
  for (const id of generated.slice(0, fill)) {
    await pool.query(
      "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_session_id) VALUES ($1, 'founding', 'confirmed', $2)",
      [id, `cs_${id}`],
    );
  }

  async function attempt(id: string): Promise<string | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockMembershipCapacity(client);
      if (!(await hasFoundingCapacity(client))) {
        await client.query("ROLLBACK");
        return null;
      }
      const session = `cs_${id}`;
      await client.query(
        "INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_session_id) VALUES ($1, 'founding', 'pending', $2)",
        [id, session],
      );
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const [first, second] = await Promise.all([attempt(generated[fill]), attempt(generated[fill + 1])]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  const winner = first || second!;
  expect(await attempt(generated[fill + 2])).toBeNull();

  const client = await pool.connect();
  try {
    await expireCheckout(client, winner);
    expect(await hasFoundingCapacity(client)).toBe(true);
    const replacement = await attempt(generated[fill + 2]);
    expect(replacement).toBeTruthy();
    expect(await confirmCheckout(client, replacement!, `sub_${prefix}`)).toBe(true);
    expect(await confirmCheckout(client, replacement!, `sub_${prefix}`)).toBe(false);
    await expireCheckout(client, replacement!);
    const member = await client.query<{ status: string; membership_tier: string }>(
      "SELECT m.status, u.membership_tier FROM membership_checkouts m JOIN users u ON u.clerk_id = m.clerk_id WHERE m.stripe_session_id = $1",
      [replacement],
    );
    expect(member.rows[0]).toMatchObject({ status: "confirmed", membership_tier: "Elevated" });
    expect(await hasFoundingCapacity(client)).toBe(false);
    await client.query("UPDATE membership_checkouts SET status = 'forfeited' WHERE stripe_session_id = $1", [replacement]);
    expect(await hasFoundingCapacity(client)).toBe(false);
  } finally {
    client.release();
  }
});