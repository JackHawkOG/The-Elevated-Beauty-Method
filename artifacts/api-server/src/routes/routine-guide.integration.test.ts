import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import pinoHttp from "pino-http";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type PoolClient } from "@workspace/db";
import * as schema from "../../../../lib/db/src/schema";
import { expect, test, vi } from "vitest";
import { requireDevelopmentDatabase } from "./test-development-database";
import { createRoutineGuideRouter, type RoutineGuideDependencies } from "./routine-guide";
import {
  createRoutineGuideClaimStore,
  ROUTINE_GUIDE_CONSENT,
  ROUTINE_GUIDE_VERSION,
  type GuideClaimStore,
} from "../lib/routine-guide-delivery";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Delivery = {
  email_hash: string; email: string; state: string; provider_idempotency_key: string;
  attempt_count: number; first_attempt_at: Date; lease_until: Date | null; accepted_at: Date | null;
};
type Sender = NonNullable<RoutineGuideDependencies["send"]>;

// Each fixture has its own migration-backed schema, three physical connections,
// reserved-domain addresses, and explicitly owned request IDs/hashes. No query
// falls back to public, including the store's global expired-counter deletion.
async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  requireDevelopmentDatabase(); // Before opening connections, setup, or cleanup.
  const name = `guide_delivery_test_${randomUUID().replaceAll("-", "")}`;
  const clients: PoolClient[] = [];
  let created = false;
  let fixture: Fixture | undefined;
  try {
    for (let i = 0; i < 3; i++) clients.push(await pool.connect());
    const [control, first, second] = clients as [PoolClient, PoolClient, PoolClient];
    await control.query(`CREATE SCHEMA "${name}"`);
    created = true;
    for (const client of clients) {
      await client.query("SELECT set_config('search_path', $1, false)", [name]);
      await client.query("SET statement_timeout = '8s'");
    }
    await control.query(await readFile(
      new URL("../../../../lib/db/migrations/0012_routine_guide_delivery.sql", import.meta.url), "utf8",
    ));
    fixture = new Fixture(control, first, second);
    await run(fixture);
  } finally {
    // Release gates before draining requests; do not delete rows while a sender
    // or transaction can still recreate them. Attempt every cleanup on failure.
    try {
      await fixture?.close();
    } finally {
      try {
        if (created) await clients[0]!.query(`DROP SCHEMA "${name}" CASCADE`);
      } finally {
        await Promise.all(clients.map(async client => {
          try {
            await client.query("ROLLBACK");
            await client.query("RESET search_path; RESET statement_timeout");
            client.release();
          } catch (error) {
            client.release(true);
            throw error;
          }
        }));
      }
    }
  }
}

class Fixture {
  readonly email = `guide-owned-${randomUUID()}@example.invalid`;
  readonly otherEmail = `guide-owned-${randomUUID()}@example.invalid`;
  readonly emailHash = hash(this.email);
  readonly otherEmailHash = hash(this.otherEmail);
  readonly requestId = randomUUID();
  readonly otherRequestId = randomUUID();
  // Never charge the loopback or owner's IP counter, even through HTTP.
  readonly ip = `guide-owned-ip-${randomUUID()}`;
  now = new Date();
  private servers: Server[] = [];
  private pending: Promise<unknown>[] = [];
  private lockedKey: string | undefined;

  constructor(readonly control: PoolClient, readonly first: PoolClient, readonly second: PoolClient) {}

  store(client: PoolClient): GuideClaimStore {
    const store = createRoutineGuideClaimStore(drizzle(client, { schema }));
    return {
      reserve: input => store.reserve({ ...input, ip: this.ip, now: this.now }),
      markAccepted: (email, key) => store.markAccepted(email, key, this.now),
      markRejected: (email, key) => store.markRejected(email, key, this.now),
      markUncertain: (email, key) => store.markUncertain(email, key, this.now),
    };
  }

  async app(client: PoolClient, send: Sender) {
    const app = express();
    app.use(pinoHttp({ level: "silent" }), express.json(), createRoutineGuideRouter({
      store: this.store(client), send, // Fake sender is mandatory; no connector call.
    }));
    const server = app.listen(0, "127.0.0.1");
    this.servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return `http://127.0.0.1:${address.port}`;
  }

  post(base: string, email = this.email, requestId = this.requestId) {
    const request = (async () => {
      const response = await fetch(`${base}/routine-guide/claim`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, requestId, consent: true }),
        signal: AbortSignal.timeout(12_000),
      });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    })();
    this.pending.push(request);
    return request;
  }

  async delivery(emailHash = this.emailHash): Promise<Delivery> {
    const result = await this.control.query<Delivery>(
      "SELECT * FROM routine_guide_deliveries WHERE guide_version = $1 AND email_hash = $2",
      [ROUTINE_GUIDE_VERSION, emailHash],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!;
  }

  async lock(key: string) {
    await this.control.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    this.lockedKey = key;
  }

  async unlock() {
    if (!this.lockedKey) return;
    await this.control.query("SELECT pg_advisory_unlock(hashtext($1))", [this.lockedKey]);
    this.lockedKey = undefined;
  }

  async competing(requests: Promise<unknown>[]) {
    // Prove both transactions are actually waiting inside PostgreSQL, rather
    // than relying on Promise.all timing to claim concurrency coverage.
    const pids = [this.first, this.second].map(client => {
      // Reading the backend PID via the client object avoids querying a busy
      // connection (which would queue behind its blocked transaction).
      return (client as PoolClient & { processID: number }).processID;
    });
    // Detect premature completion without leaving a losing polling promise
    // running against a connection after fixture cleanup has released it.
    let endedEarly = false;
    for (const request of requests) {
      void request.then(() => { endedEarly = true; }, () => { endedEarly = true; });
    }
    for (let i = 0; i < 300; i++) {
      if (endedEarly) throw new Error("Claim finished before reaching the concurrency gate");
      const result = await this.control.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = ANY($1::integer[])",
        [pids],
      );
      if (result.rows[0]!.count === 2) {
        await this.unlock();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Both claims did not reach PostgreSQL advisory-lock contention");
  }

  async restartServers() {
    await Promise.all(this.servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    })));
    this.servers = [];
  }

  async close() {
    await this.unlock();
    await Promise.allSettled(this.pending);
    await this.restartServers();
  }
}

test.each(["same request", "different requests"])(
  "concurrent first claims with %s send once and persist unique delivery/consent records",
  async mode => withFixture(async f => {
    const send = vi.fn<Sender>(async () => "accepted");
    const a = await f.app(f.first, send);
    const b = await f.app(f.second, send);
    await f.lock(`routine-guide:email:${f.emailHash}`);
    const requests = [
      f.post(a, `  ${f.email.toUpperCase()}  `),
      f.post(b, f.email, mode === "same request" ? f.requestId : f.otherRequestId),
    ];
    await f.competing(requests);
    const responses = await Promise.all(requests);
    expect(responses.every(r => r.status === 200 || r.status === 202)).toBe(true);
    expect(responses.some(r => r.status === 200 && r.data.status === "sent")).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const delivery = await f.delivery();
    expect(delivery).toMatchObject({ email: f.email, state: "sent", attempt_count: 1, lease_until: null });
    expect(delivery.accepted_at).toBeInstanceOf(Date);
    expect(send).toHaveBeenCalledWith(f.email, delivery.provider_idempotency_key);
    const claims = (await f.control.query("SELECT * FROM routine_guide_claims")).rows;
    expect(claims).toHaveLength(mode === "same request" ? 1 : 2);
    expect(claims.map(c => c.request_id).sort()).toEqual(
      (mode === "same request" ? [f.requestId] : [f.requestId, f.otherRequestId]).sort(),
    );
    for (const claim of claims) expect(claim).toMatchObject({
      email_hash: f.emailHash, consent: true, consent_text: ROUTINE_GUIDE_CONSENT, guide_version: ROUTINE_GUIDE_VERSION,
    });
    expect((await f.control.query("SELECT * FROM routine_guide_deliveries")).rows).toHaveLength(1);
    expect((await f.post(b)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const counters = (await f.control.query("SELECT key_hash, attempts FROM routine_guide_rate_limits")).rows;
    expect(counters).toHaveLength(2);
    expect(counters).toEqual(expect.arrayContaining([
      { key_hash: `email:${f.emailHash}`, attempts: mode === "same request" ? 1 : 2 },
      { key_hash: `ip:${hash(f.ip)}`, attempts: mode === "same request" ? 1 : 2 },
    ]));
  }), 20_000,
);

test("simultaneous reuse of one request ID for different addresses produces one send and one conflict",
  async () => withFixture(async f => {
    const send = vi.fn<Sender>(async () => "accepted");
    const a = await f.app(f.first, send);
    const b = await f.app(f.second, send);
    await f.lock(`routine-guide:request:${f.requestId}`);
    const requests = [f.post(a), f.post(b, f.otherEmail)];
    await f.competing(requests);
    expect((await Promise.all(requests)).map(r => r.status).sort()).toEqual([200, 409]);
    expect(send).toHaveBeenCalledTimes(1);
    const winningEmail = send.mock.calls[0]![0];
    expect((await f.control.query("SELECT * FROM routine_guide_claims")).rows)
      .toMatchObject([{ request_id: f.requestId, email_hash: hash(winningEmail) }]);
    expect((await f.control.query("SELECT * FROM routine_guide_deliveries")).rows)
      .toMatchObject([{ email: winningEmail, state: "sent", attempt_count: 1 }]);
    expect((await f.control.query("SELECT * FROM routine_guide_rate_limits")).rows).toHaveLength(2);
  }), 20_000,
);

test.each(["processing", "uncertain"] as const)(
  "a restarted store preserves an active %s lease then serializes recovery with the original provider key",
  async state => withFixture(async f => {
    const initialStore = f.store(f.first);
    const initial = await initialStore.reserve({ email: f.email, requestId: f.requestId, ip: f.ip });
    expect(initial.kind).toBe("send");
    if (initial.kind !== "send") throw new Error("Expected initial claim");
    if (state === "uncertain") await initialStore.markUncertain(f.email, initial.providerIdempotencyKey);
    // Abandon the original store/worker; fresh routers retain no in-memory state.
    const send = vi.fn<Sender>(async () => "accepted");
    const a = await f.app(f.first, send);
    const b = await f.app(f.second, send);
    expect(await f.post(a)).toMatchObject({ status: 202, data: { status: "processing" } });
    expect(send).not.toHaveBeenCalled();
    f.now = new Date(f.now.getTime() + 89_999);
    expect((await f.post(b)).status).toBe(202);
    expect(send).not.toHaveBeenCalled();
    f.now = new Date(f.now.getTime() + 1);
    await f.lock(`routine-guide:email:${f.emailHash}`);
    const requests = [f.post(a), f.post(b)];
    await f.competing(requests);
    const recovered = await Promise.all(requests);
    expect(recovered.every(r => r.status === 200 || r.status === 202)).toBe(true);
    expect(recovered.some(r => r.status === 200)).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(f.email, initial.providerIdempotencyKey);
    expect(await f.delivery()).toMatchObject({
      state: "sent", provider_idempotency_key: initial.providerIdempotencyKey, attempt_count: 2, lease_until: null,
    });
  }), 20_000,
);

test("an acceptance write rejected by PostgreSQL reports uncertainty and restart recovery never creates a new provider key",
  async () => withFixture(async f => {
    // Simulate a real DB write failure, not an in-memory store throwing.
    await f.control.query(`ALTER TABLE routine_guide_deliveries ADD CONSTRAINT reject_fixture_acceptance CHECK (state <> 'sent')`);
    const acceptedKeys = new Set<string>();
    const send = vi.fn<Sender>(async (_email, key) => {
      acceptedKeys.add(key); // Fake provider's idempotency ledger survives restart.
      return "accepted";
    });
    const a = await f.app(f.first, send);
    const failed = await f.post(a);
    expect(failed.status).toBe(503);
    expect(failed.data.error).toContain("retry safely using the same request ID");
    const original = await f.delivery();
    expect(original).toMatchObject({ state: "processing", accepted_at: null, attempt_count: 1 });
    await f.restartServers();
    await f.control.query("ALTER TABLE routine_guide_deliveries DROP CONSTRAINT reject_fixture_acceptance");
    const b = await f.app(f.second, send);
    expect((await f.post(b)).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    f.now = new Date(f.now.getTime() + 90_001);
    expect((await f.post(b)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(acceptedKeys).toEqual(new Set([original.provider_idempotency_key]));
    expect(await f.delivery()).toMatchObject({
      state: "sent", attempt_count: 2, provider_idempotency_key: original.provider_idempotency_key,
      first_attempt_at: original.first_attempt_at,
    });
    expect((await f.post(b)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  }), 20_000,
);

test("uncertain delivery stops exactly at the provider's 24-hour window, including new request IDs",
  async () => withFixture(async f => {
    const send = vi.fn<Sender>(async () => "uncertain");
    const a = await f.app(f.first, send);
    expect((await f.post(a)).status).toBe(503);
    const original = await f.delivery();
    expect(original.state).toBe("uncertain");
    await f.restartServers();
    const b = await f.app(f.second, send);
    f.now = new Date(original.first_attempt_at.getTime() + 24 * 60 * 60 * 1000);
    for (const id of [f.requestId, f.otherRequestId]) {
      const result = await f.post(b, f.email, id);
      expect(result.status).toBe(503);
      expect(result.data.error).toContain("could not safely confirm");
    }
    expect(await f.delivery()).toEqual(original);
    expect(send).toHaveBeenCalledTimes(1);
  }), 20_000,
);

test("retry conflicts and stale provider keys cannot mutate an existing delivery or send to another address",
  async () => withFixture(async f => {
    const send = vi.fn<Sender>(async () => "rejected");
    const a = await f.app(f.first, send);
    expect((await f.post(a)).status).toBe(503);
    const original = await f.delivery();
    expect(original.state).toBe("failed");
    expect((await f.post(a, f.otherEmail)).status).toBe(409);
    expect((await f.control.query("SELECT * FROM routine_guide_deliveries WHERE email_hash = $1", [f.otherEmailHash])).rows).toEqual([]);
    await f.control.query("UPDATE routine_guide_claims SET guide_version = $1 WHERE request_id = $2 AND email_hash = $3",
      ["owned-test-previous-version", f.requestId, f.emailHash]);
    expect((await f.post(a)).status).toBe(409);
    const store = f.store(f.second);
    for (const mark of [store.markAccepted, store.markRejected, store.markUncertain]) {
      await expect(mark(f.email, randomUUID())).rejects.toThrow("state was not recorded");
    }
    expect(await f.delivery()).toEqual(original);
    expect(send).toHaveBeenCalledTimes(1);
    await f.control.query("UPDATE routine_guide_claims SET guide_version = $1 WHERE request_id = $2 AND email_hash = $3",
      [ROUTINE_GUIDE_VERSION, f.requestId, f.emailHash]);
    const accepted = vi.fn<Sender>(async () => "accepted");
    const b = await f.app(f.second, accepted);
    expect((await f.post(b)).status).toBe(200);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(f.email, original.provider_idempotency_key);
    expect(await f.delivery()).toMatchObject({ state: "sent", attempt_count: 2 });
  }), 20_000,
);

test("migration enforces unique request IDs, address/version deliveries, and provider keys",
  async () => withFixture(async f => {
    await f.store(f.first).reserve({ email: f.email, requestId: f.requestId, ip: f.ip });
    const delivery = await f.delivery();
    await expect(f.control.query(
      "INSERT INTO routine_guide_claims SELECT * FROM routine_guide_claims WHERE request_id = $1", [f.requestId],
    )).rejects.toMatchObject({ code: "23505" });
    await expect(f.control.query(
      "INSERT INTO routine_guide_deliveries SELECT * FROM routine_guide_deliveries WHERE email_hash = $1", [f.emailHash],
    )).rejects.toMatchObject({ code: "23505" });
    await expect(f.control.query(
      `INSERT INTO routine_guide_deliveries
       (guide_version, email_hash, email, state, provider_idempotency_key)
       VALUES ($1, $2, $3, 'processing', $4)`,
      [ROUTINE_GUIDE_VERSION, f.otherEmailHash, f.otherEmail, delivery.provider_idempotency_key],
    )).rejects.toMatchObject({ code: "23505" });
    expect(await f.delivery()).toEqual(delivery);
  }), 20_000,
);