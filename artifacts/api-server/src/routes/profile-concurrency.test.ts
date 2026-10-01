import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireDevelopmentDatabase } from "./test-development-database";
import { ensureProfileSchema } from "../lib/ensure-profile-schema";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    req.userId = req.header("x-test-user");
    if (!req.userId) { res.status(401).json({ error: "Sign in required" }); return; }
    next();
  },
  jitProvisionUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const account = `profile-concurrency-${randomUUID()}`;
const otherAccount = `profile-concurrency-${randomUUID()}`;
let safe = false;
let server: Server | undefined;
let baseUrl: string;
let releaseEarlier: (() => void) | undefined;
let earlierArrived: (() => void) | undefined;
let delay: Promise<void>;

async function request(method: string, body?: object, user = account, hold = false) {
  const response = await fetch(`${baseUrl}/users/me`, {
    method,
    headers: {
      "x-test-user": user,
      "content-type": "application/json",
      ...(hold ? { "x-hold-earlier": "yes" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  safe = true;
  await ensureProfileSchema();
  await db.insert(usersTable).values([account, otherAccount].map(clerkId => ({
    clerkId, displayName: "Original", bio: "Original bio", email: `${clerkId}@example.invalid`,
  })));
  const { default: router } = await import("./users");
  const app = express();
  app.use(express.json());
  // Hold the first request on the server, not its already-committed response.
  app.use(async (req, _res, next) => {
    if (req.header("x-hold-earlier")) {
      earlierArrived?.();
      await delay;
    }
    next();
  });
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  releaseEarlier?.();
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (safe) {
    requireDevelopmentDatabase();
    for (const clerkId of [account, otherAccount]) {
      await db.delete(usersTable).where(eq(usersTable.clerkId, clerkId));
    }
  }
});

test("a server-delayed older PATCH cannot overwrite a newer committed edit", async () => {
  const baseline = (await request("GET")).data;
  delay = new Promise(resolve => { releaseEarlier = resolve; });
  const arrived = new Promise<void>(resolve => { earlierArrived = resolve; });
  const older = request("PATCH", {
    profileVersion: baseline.profileVersion, displayName: "Earlier", bio: "Earlier bio",
  }, account, true);
  await arrived;
  let newer;
  try {
    newer = await request("PATCH", {
      profileVersion: baseline.profileVersion, displayName: "Newer", bio: "",
    });
    expect(newer.status).toBe(200);
    expect(newer.data.profileVersion).not.toBe(baseline.profileVersion);
  } finally {
    releaseEarlier!();
  }
  const rejected = await older;
  expect(rejected.status).toBe(409);
  expect(rejected.data.currentProfile).toMatchObject(newer!.data);
  expect((await request("GET")).data).toMatchObject({ displayName: "Newer", bio: "", profileVersion: newer!.data.profileVersion });
  const [stored] = await db.select().from(usersTable).where(eq(usersTable.clerkId, account));
  expect(stored.displayName).toBe("Newer");
  // A reviewed retry uses the returned current version and receives a new one.
  const retried = await request("PATCH", { profileVersion: rejected.data.currentProfile.profileVersion, bio: "Reviewed edit" });
  expect(retried.status).toBe(200);
  expect(retried.data.profileVersion).not.toBe(newer!.data.profileVersion);
});

test("competing writes to the same version have exactly one winner", async () => {
  const baseline = (await request("GET")).data;
  const responses = await Promise.all(["First", "Second"].map(displayName =>
    request("PATCH", { profileVersion: baseline.profileVersion, displayName })));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = responses.find(r => r.status === 200)!;
  expect((await request("GET")).data).toMatchObject(winner.data);
});

test("missing, malformed and another member's versions cannot write", async () => {
  const baseline = (await request("GET")).data;
  expect((await request("PATCH", { displayName: "Unversioned" })).status).toBe(400);
  expect((await request("PATCH", { profileVersion: "invalid", displayName: "Invalid" })).status).toBe(400);
  expect((await request("PATCH", { profileVersion: 1, displayName: "Invalid" })).status).toBe(400);
  expect((await request("PATCH", { profileVersion: baseline.profileVersion, displayName: "Cross-account" }, otherAccount)).status).toBe(409);
  expect((await request("GET", undefined, otherAccount)).data.displayName).toBe("Original");
  expect((await request("PATCH", { profileVersion: baseline.profileVersion }, `missing-${randomUUID()}`)).status).toBe(404);
  expect((await request("GET")).data).toMatchObject(baseline);
});