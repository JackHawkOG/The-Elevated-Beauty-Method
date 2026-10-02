import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { pool, type PoolClient } from "@workspace/db";
import { ensureMembershipSchema } from "./ensure-membership-schema";
import { requireDevelopmentDatabase } from "../routes/test-development-database";
import { deliverMembershipReviewEmails } from "./membership-review-email";

const schema = `review_email_${randomUUID().replaceAll("-", "")}`;
let client: PoolClient;
let lease: PoolClient;
let created = false;
const send = vi.fn(async (_email: string, _url: string, _key: string) => "accepted" as "accepted" | "failed");
const recipient = vi.fn(async () => ({ email: "owner@example.invalid" } as { email: string } | null));
const reviewUrl = "https://example.invalid/membership";
const tables = ["membership_checkouts", "membership_reconciliation_failures", "membership_sweep_health", "membership_review_email_preferences", "membership_review_email_deliveries"];

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureMembershipSchema();
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  created = true;
  for (const table of tables) await client.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  await client.query(`SET search_path TO ${schema}`);
  lease = Object.assign(Object.create(client), { query: client.query.bind(client), release: () => {} }) as PoolClient;
}, 30000);
afterAll(async () => {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    if (created) await client.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally { client.release(); }
});
beforeEach(async () => {
  for (const table of tables) await client.query(`DELETE FROM ${table}`);
  send.mockReset().mockResolvedValue("accepted");
  recipient.mockReset().mockResolvedValue({ email: "owner@example.invalid" });
});

async function fail(notificationId = randomUUID()) {
  const subscription = `sub_${randomUUID()}`;
  await client.query("INSERT INTO membership_checkouts (clerk_id, kind, status, stripe_subscription_id) VALUES ('member-fixture', 'founding', 'confirmed', $1)", [subscription]);
  await client.query(`INSERT INTO membership_reconciliation_failures (stripe_subscription_id, consecutive_failures, notification_id, notified_at)
    VALUES ($1, 3, $2, now())`, [subscription, notificationId]);
  return notificationId;
}
async function optIn(enabled = true) {
  await client.query("INSERT INTO membership_review_email_preferences (clerk_id, enabled) VALUES ('owner-fixture', $1) ON CONFLICT (clerk_id) DO UPDATE SET enabled = EXCLUDED.enabled", [enabled]);
}
const run = () => deliverMembershipReviewEmails({ send, recipient, reviewUrl, connect: async () => lease });
async function rows() {
  return (await client.query("SELECT * FROM membership_review_email_deliveries ORDER BY retry_at")).rows;
}
const due = () => client.query("UPDATE membership_review_email_deliveries SET retry_at = now() - interval '1 minute'");

test("no opt-in means no delivery; successful delivery is durable and only a new failure streak sends again", async () => {
  const id = await fail();
  await run();
  expect(send).not.toHaveBeenCalled();
  await optIn();
  await run();
  expect(send).toHaveBeenCalledTimes(1);
  const [delivery] = await rows();
  expect(delivery.status).toBe("sent");
  expect(delivery.recipient).toBeNull();
  expect(send).toHaveBeenCalledWith("owner@example.invalid", reviewUrl, `membership-review/${delivery.id}`);
  await run(); // A new invocation observes durable success, like a restarted worker.
  expect(send).toHaveBeenCalledTimes(1);
  await client.query("DELETE FROM membership_reconciliation_failures WHERE notification_id = $1", [id]);
  await fail();
  await run();
  expect(send).toHaveBeenCalledTimes(2);
});

test("failed sends retry with byte-identical recipient, URL and key, even if configuration changes", async () => {
  await fail(); await optIn();
  send.mockResolvedValueOnce("failed");
  await run();
  expect((await rows())[0].status).toBe("pending");
  await due();
  await deliverMembershipReviewEmails({ send, recipient, reviewUrl: "https://changed.invalid/membership", connect: async () => lease });
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect((await rows())[0].status).toBe("sent");
});

test.each(["recovery", "opt-out", "ended-membership", "owner-demotion", "changed-email"])("%s suppresses a pending email before retry", async reason => {
  await fail(); await optIn();
  send.mockResolvedValue("failed");
  await run(); await due();
  if (reason === "recovery") await client.query("DELETE FROM membership_reconciliation_failures");
  if (reason === "opt-out") await optIn(false);
  if (reason === "ended-membership") await client.query("UPDATE membership_checkouts SET status = 'forfeited'");
  if (reason === "owner-demotion") recipient.mockResolvedValue(null);
  if (reason === "changed-email") recipient.mockResolvedValue({ email: "changed@example.invalid" });
  await run();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await rows())[0].status).toBe("suppressed");
  expect((await rows())[0].recipient).toBeNull();
});

test("recovery in the preparation gap suppresses an unsent email", async () => {
  await fail(); await optIn();
  const query = client.query.bind(client);
  let committed = false;
  const injected = Object.assign(Object.create(client), {
    release: () => {},
    query: async (sql: string, args?: unknown[]) => {
      const result = await query(sql, args);
      if (sql === "COMMIT" && !committed) {
        committed = true;
        await query("DELETE FROM membership_reconciliation_failures");
      }
      return result;
    },
  }) as PoolClient;
  await deliverMembershipReviewEmails({ send, recipient, reviewUrl, connect: async () => injected });
  expect(send).not.toHaveBeenCalled();
  expect((await rows())[0].status).toBe("suppressed");
});

test("an accepted send with a lost acknowledgement retries the same key, never a fresh key", async () => {
  await fail(); await optIn();
  const query = client.query.bind(client);
  const injected = Object.assign(Object.create(client), {
    release: () => {},
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes("SET status = 'sent'")) throw new Error("database write failed after acceptance");
      return query(sql, args);
    },
  }) as PoolClient;
  await deliverMembershipReviewEmails({ send, recipient, reviewUrl, connect: async () => injected });
  expect((await rows())[0].status).toBe("pending");
  await due(); await run();
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect((await rows())[0].status).toBe("sent");
});

test("ambiguous deliveries stop before provider idempotency expires", async () => {
  await fail(); await optIn();
  send.mockResolvedValue("failed");
  await run(); await due();
  await client.query("UPDATE membership_review_email_deliveries SET first_attempt_at = now() - interval '24 hours'");
  await run(); await run();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await rows())[0].status).toBe("uncertain");
});

test("sweep-wide outages need three failures over thirty minutes and clear on recovery", async () => {
  await optIn();
  await client.query("INSERT INTO membership_sweep_health (consecutive_failures, first_failed_at, last_failed_at) VALUES (3, now() - interval '2 minutes', now())");
  await run();
  expect(send).not.toHaveBeenCalled();
  await client.query("UPDATE membership_sweep_health SET first_failed_at = now() - interval '30 minutes', last_failed_at = now()");
  send.mockResolvedValue("failed");
  await run(); await due();
  await client.query("DELETE FROM membership_sweep_health");
  await run();
  expect(send).toHaveBeenCalledTimes(1);
  expect((await rows())[0].status).toBe("suppressed");
});

test("two server workers cannot send the same queued alert concurrently", async () => {
  await fail(); await optIn();
  let finish!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  send.mockImplementation(async () => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    return "accepted";
  });
  const first = run();
  await sending;
  const second = await pool.connect();
  try {
    await second.query(`SET search_path TO ${schema}`);
    const secondLease = Object.assign(Object.create(second), { query: second.query.bind(second), release: () => {} }) as PoolClient;
    await deliverMembershipReviewEmails({ send, recipient, reviewUrl, connect: async () => secondLease });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    finish(); await first;
    await second.query("RESET search_path");
    second.release();
  }
  expect((await rows())[0].status).toBe("sent");
});

test("a recovery racing an in-flight send cannot commit before dispatch is resolved", async () => {
  const notificationId = await fail(); await optIn();
  let finish!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  send.mockImplementation(async () => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    return "accepted";
  });
  const first = run();
  await sending;
  const second = await pool.connect();
  let recovered = false;
  let recovery: Promise<unknown> | undefined;
  try {
    recovery = second.query(`DELETE FROM ${schema}.membership_reconciliation_failures WHERE notification_id = $1`, [notificationId])
      .then(() => { recovered = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(recovered).toBe(false);
  } finally {
    finish(); await first; await recovery;
    second.release();
  }
  expect(recovered).toBe(true);
  await run();
  expect(send).toHaveBeenCalledTimes(1);
});