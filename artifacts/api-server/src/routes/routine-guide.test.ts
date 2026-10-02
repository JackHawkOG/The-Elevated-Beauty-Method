import { afterEach, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
// These route tests inject an in-memory claim store. Fail explicitly if a test
// ever reaches the production database rather than constructing a live pool.
vi.mock("@workspace/db", () => ({
  db: new Proxy({}, {
    get() { throw new Error("Routine guide unit tests must not access a database"); },
  }),
  routineGuideClaimsTable: {},
  routineGuideDeliveriesTable: {},
  routineGuideRateLimitsTable: {},
}));
import {
  getRoutineGuideDeliveryAction,
  type GuideClaimStore,
  type Reservation,
} from "../lib/routine-guide-delivery";
import { createRoutineGuideRouter, createRoutineGuideSender } from "./routine-guide";

type FakeDelivery = {
  key: string;
  state: "processing" | "sent" | "failed" | "uncertain";
  leaseUntil: number;
  firstAttemptAt: number;
};

class FakeStore implements GuideClaimStore {
  requests = new Map<string, string>();
  deliveries = new Map<string, FakeDelivery>();
  addressAttempts = new Map<string, number>();
  ipAttempts = new Map<string, number>();
  now = Date.now();

  async reserve(input: { requestId: string; email: string; ip: string }): Promise<Reservation> {
    const existingEmail = this.requests.get(input.requestId);
    if (existingEmail && existingEmail !== input.email) return { kind: "conflict" };
    if (!existingEmail) {
      const addressAttempts = (this.addressAttempts.get(input.email) ?? 0) + 1;
      const ipAttempts = (this.ipAttempts.get(input.ip) ?? 0) + 1;
      this.addressAttempts.set(input.email, addressAttempts);
      this.ipAttempts.set(input.ip, ipAttempts);
      if (addressAttempts > 5 || ipAttempts > 20) return { kind: "rate_limited" };
      this.requests.set(input.requestId, input.email);
    }

    const delivery = this.deliveries.get(input.email);
    if (!delivery) {
      const key = `provider-key-${input.email}`;
      this.deliveries.set(input.email, {
        key,
        state: "processing",
        leaseUntil: this.now + 90_000,
        firstAttemptAt: this.now,
      });
      return { kind: "send", providerIdempotencyKey: key };
    }
    const action = getRoutineGuideDeliveryAction({
      state: delivery.state,
      leaseUntil: delivery.leaseUntil ? new Date(delivery.leaseUntil) : null,
      firstAttemptAt: new Date(delivery.firstAttemptAt),
    }, new Date(this.now));
    if (action === "sent") return { kind: "sent" };
    if (action === "processing") return { kind: "processing" };
    if (action === "ambiguous_expired") return { kind: "ambiguous_expired" };
    delivery.state = "processing";
    delivery.leaseUntil = this.now + 90_000;
    return { kind: "send", providerIdempotencyKey: delivery.key };
  }

  async markAccepted(email: string): Promise<void> {
    const delivery = this.deliveries.get(email)!;
    delivery.state = "sent";
    delivery.leaseUntil = 0;
  }

  async markRejected(email: string): Promise<void> {
    const delivery = this.deliveries.get(email)!;
    delivery.state = "failed";
    delivery.leaseUntil = 0;
  }

  async markUncertain(email: string): Promise<void> {
    const delivery = this.deliveries.get(email)!;
    delivery.state = "uncertain";
    delivery.leaseUntil = Date.now() + 90_000;
  }
}

let server: Server | undefined;

async function startApp(store = new FakeStore(), send: (email: string, key: string) => Promise<"accepted" | "rejected" | "uncertain"> = async () => "accepted") {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json(), createRoutineGuideRouter({ store, send }));
  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return { store, base: `http://127.0.0.1:${address.port}` };
}

async function post(base: string, input: unknown, ip = "127.0.0.1") {
  const response = await fetch(`${base}/routine-guide/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

function validInput(email: string, requestId: string) {
  return { email, consent: true, requestId };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
});

test("public metadata is guide-only and the library remains empty until publication is configured", async () => {
  vi.stubEnv("ROUTINE_GUIDE_LIBRARY_PUBLISHED", "false");
  const { base } = await startApp();
  const guide = await fetch(`${base}/routine-guide`).then(response => response.json()) as Record<string, unknown>;
  expect(guide).toMatchObject({
    title: "The Elevated Routine",
    consentText: "Email me The Elevated Routine from The Elevated Beauty Method ™.",
    version: "1",
    pageCount: 9,
    available: true,
    publishedInLibrary: false,
  });
  expect(guide.privacyNotice).toContain("Resend");
  expect(guide.privacyNotice).toContain("not add you to marketing");
  expect(guide.privacyNotice).toContain("hello@elevatedbeautymethod.com");
  expect(await fetch(`${base}/digital-guides`).then(response => response.json())).toEqual([]);
});

test("only explicit library-publication configuration exposes its metadata listing", async () => {
  vi.stubEnv("ROUTINE_GUIDE_LIBRARY_PUBLISHED", "true");
  const { base } = await startApp();
  const listing = await fetch(`${base}/digital-guides`).then(response => response.json()) as Array<Record<string, unknown>>;
  expect(listing).toHaveLength(1);
  expect(listing[0]).toMatchObject({ title: "The Elevated Routine", publishedInLibrary: true });
  expect(await fetch(`${base}/routine-guide`).then(response => response.json())).toMatchObject({ publishedInLibrary: true });
});

test("invalid email, missing explicit consent, and honeypot submissions do not send", async () => {
  const send = vi.fn(async (_email: string, _key: string) => "accepted" as const);
  const { base } = await startApp(new FakeStore(), send);
  const id = "c1ad1a5e-15a2-44a4-9c11-45e451daf67a";
  expect((await post(base, validInput("bad", id))).status).toBe(400);
  expect((await post(base, { ...validInput("person@example.com", id), consent: false })).status).toBe(400);
  expect((await post(base, { ...validInput("person@example.com", id), website: "bot" })).status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

test("explicit consent sends once, normalizes email, and makes request ID reuse conflicts clear", async () => {
  const store = new FakeStore();
  const send = vi.fn(async (_email: string, _key: string) => "accepted" as const);
  const { base } = await startApp(store, send);
  const requestId = "c1ad1a5e-15a2-44a4-9c11-45e451daf67a";
  const first = await post(base, validInput("  Guide.User@Example.com ", requestId));
  expect(first.status).toBe(200);
  expect(first.data.status).toBe("sent");
  expect(first.data.message).toContain("accepted");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBe("guide.user@example.com");
  expect((await post(base, validInput("guide.user@example.com", requestId))).status).toBe(200);
  expect((await post(base, validInput("another@example.com", requestId))).status).toBe(409);
  expect((await post(base, validInput("guide.user@example.com", "22e1b724-85b7-4b69-b4c4-6efec88778f6"))).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
});

test("address-level rate limits return 429", async () => {
  const store = new FakeStore();
  const second = await startApp(store);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await post(second.base, validInput("limited@example.com", `22e1b724-85b7-4b69-b4c4-6efec887780${attempt}`), `192.0.2.${attempt + 1}`);
  }
  expect((await post(second.base, validInput("limited@example.com", "22e1b724-85b7-4b69-b4c4-6efec8877812"), "192.0.2.8")).status).toBe(429);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await post(second.base, validInput(
      `ip-limit-${attempt}@example.com`,
      `33333333-3333-4333-8333-${String(attempt).padStart(12, "0")}`,
    ), "198.51.100.9");
  }
  expect((await post(second.base, validInput("ip-limit-last@example.com", "33333333-3333-4333-8333-999999999999"), "198.51.100.9")).status).toBe(429);
});

test("uncertain sends retry only with the same idempotency key and stop after Resend's 24-hour window", async () => {
  const store = new FakeStore();
  const keys: string[] = [];
  let sendResult: "accepted" | "rejected" | "uncertain" = "uncertain";
  const send = vi.fn(async (_email: string, key: string) => {
    keys.push(key);
    return sendResult;
  });
  const { base } = await startApp(store, send);
  const input = validInput("uncertain@example.com", "c1ad1a5e-15a2-44a4-9c11-45e451daf67a");
  expect((await post(base, input)).status).toBe(503);
  expect((await post(base, input)).status).toBe(202);
  store.now += 91_000;
  sendResult = "accepted";
  expect((await post(base, input)).status).toBe(200);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);

  sendResult = "uncertain";
  const staleAttempt = validInput("old-uncertain@example.com", "22e1b724-85b7-4b69-b4c4-6efec8877899");
  expect((await post(base, staleAttempt)).status).toBe(503);
  store.now += 25 * 60 * 60 * 1000;
  expect((await post(base, validInput("old-uncertain@example.com", "22e1b724-85b7-4b69-b4c4-6efec8877801"))).status).toBe(503);
  expect(keys).toHaveLength(3);
});

test("a known provider rejection reports 503 and permits an explicit safe retry", async () => {
  const store = new FakeStore();
  let next: "accepted" | "rejected" = "rejected";
  const send = vi.fn(async () => next);
  const { base } = await startApp(store, send);
  const input = validInput("retry@example.com", "c1ad1a5e-15a2-44a4-9c11-45e451daf67a");
  expect((await post(base, input)).status).toBe(503);
  next = "accepted";
  expect((await post(base, input)).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
});

test("Resend sender submits the byte-identical private PDF with guide-only sender identity and idempotency", async () => {
  const attachmentPath = path.resolve("artifacts/api-server/private-assets/the-elevated-routine.pdf");
  const bytes = await readFile(attachmentPath);
  const proxy = vi.fn(async (_connector: string, _endpoint: string, options: { headers: Record<string, string>; body: Record<string, any> }) =>
    new Response(JSON.stringify({ id: "accepted" }), { status: 200 }));
  // Omit the path override to cover source-runtime resolution. The build script
  // separately checks and copies the same private asset beside the bundle.
  const outcome = await createRoutineGuideSender(undefined, proxy as any)("person@example.com", "stable-key");
  expect(outcome).toBe("accepted");
  expect(proxy).toHaveBeenCalledWith("resend", "/emails", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ "Idempotency-Key": "stable-key" }),
  }));
  const payload = proxy.mock.calls[0]?.[2].body;
  expect(payload.from).toBe("The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>");
  expect(payload.reply_to).toBe("hello@elevatedbeautymethod.com");
  expect(payload.to).toEqual(["person@example.com"]);
  expect(payload.attachments[0].filename).toBe("the-elevated-routine.pdf");
  expect(Buffer.from(payload.attachments[0].content, "base64")).toEqual(bytes);
  expect(payload).not.toHaveProperty("html");
  expect(payload.text).toContain("You requested this guide only.");
  expect(payload.text).toContain("You have not been subscribed to marketing emails.");
  expect(payload.text).toContain("reply to this email");
  expect(payload.text).not.toContain("Provider acceptance");
}, 15_000);

test("provider failures never leak provider response details or report success", async () => {
  const proxy = vi.fn(async () => new Response("private provider details", { status: 503 }));
  const sender = createRoutineGuideSender(
    path.resolve("artifacts/api-server/private-assets/the-elevated-routine.pdf"),
    proxy as any,
  );
  expect(await sender("person@example.com", "stable-key")).toBe("uncertain");
  const store = new FakeStore();
  const { base } = await startApp(store, async () => "rejected");
  const response = await post(base, validInput("provider@example.com", "c1ad1a5e-15a2-44a4-9c11-45e451daf67a"));
  expect(response.status).toBe(503);
  expect(JSON.stringify(response.data)).not.toContain("provider details");
});

test("a missing or changed private attachment is rejected before the provider is called", async () => {
  const proxy = vi.fn();
  const sender = createRoutineGuideSender(path.resolve("artifacts/api-server/package.json"), proxy as any);
  expect(await sender("person@example.com", "stable-key")).toBe("preflight_failure");
  expect(proxy).not.toHaveBeenCalled();
});

test("startup ensures additive schema and migration includes the same persisted delivery tables", async () => {
  const execute = vi.fn(async () => ({}));
  const where = vi.fn(async () => []);
  const remove = vi.fn(() => ({ where }));
  vi.resetModules();
  vi.doMock("@workspace/db", () => ({ db: { execute, delete: remove }, routineGuideRateLimitsTable: { windowStartedAt: {} } }));
  vi.doMock("drizzle-orm", () => ({ sql: vi.fn(() => ({})), lt: vi.fn(() => ({})) }));
  const { ensureRoutineGuideSchema } = await import("../lib/ensure-routine-guide-schema");
  await ensureRoutineGuideSchema();
  expect(execute).toHaveBeenCalledTimes(5);
  expect(remove).toHaveBeenCalledOnce();
  vi.doUnmock("@workspace/db");
  vi.doUnmock("drizzle-orm");
  const migration = await readFile(path.resolve("lib/db/migrations/0012_routine_guide_delivery.sql"), "utf8");
  const startup = await readFile(path.resolve("artifacts/api-server/src/index.ts"), "utf8");
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS "routine_guide_claims"');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS "routine_guide_deliveries"');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS "routine_guide_rate_limits"');
  expect(startup).toContain("await ensureRoutineGuideSchema();");
});