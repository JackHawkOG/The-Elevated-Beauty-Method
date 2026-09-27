import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, memberStoriesTable, pool } from "@workspace/db";
import { requireDevelopmentDatabase } from "./test-development-database";
import { ensureMemberStoriesSchema } from "../lib/ensure-member-stories-schema";

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: async (id: string) => ({
    publicMetadata: { role: id.startsWith("test-owner-") ? "owner" : "member" },
  }) } },
}));

const run = randomUUID();
const owner = `test-owner-${run}`;
const member = `test-member-${run}`;
const created: number[] = [];
let server: Server;
let base: string;

async function request(path: string, user?: string, method = "GET", body?: object) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(user ? { "x-test-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as any, cache: response.headers.get("cache-control") };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureMemberStoriesSchema();
  const { default: routes } = await import("./member-stories");
  const app = express();
  app.use(express.json(), routes);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (created.length) await db.delete(memberStoriesTable).where(inArray(memberStoriesTable.id, created));
  } finally {
    await pool.end();
  }
});

test("only explicitly permitted stories reach the public feed and withdrawal isolates a story", async () => {
  const input = { quote: `Member quote ${run}`, attribution: "Approved name", permissionRecord: "Written approval of exact quote and name on September 27, 2026", permissionConfirmed: true };
  expect((await request("/member-stories", undefined, "POST", input)).status).toBe(401);
  expect((await request("/member-stories", member, "POST", input)).status).toBe(403);
  expect((await request("/member-stories", owner, "POST", { ...input, permissionConfirmed: false })).status).toBe(400);
  expect((await request("/member-stories", owner, "POST", { ...input, permissionRecord: "  " })).status).toBe(400);
  const first = await request("/member-stories", owner, "POST", input);
  expect(first.status).toBe(201);
  created.push(first.data.id);
  expect(first.data.permissionRecordedBy).toBe(owner);
  expect(first.data.permissionRecord).toBe(input.permissionRecord);
  const second = await request("/member-stories", owner, "POST", { ...input, quote: `Another ${run}` });
  expect(second.status).toBe(201);
  created.push(second.data.id);
  expect((await request("/member-stories/manage", member)).status).toBe(403);
  expect((await request("/member-stories/manage", owner)).data.find((story: { id: number }) => story.id === first.data.id).permissionRecord).toBe(input.permissionRecord);
  const publicBefore = await request("/member-stories");
  expect(publicBefore.cache).toContain("no-store");
  expect(publicBefore.data.filter((story: { id: number }) => created.includes(story.id))).toHaveLength(2);
  expect(publicBefore.data.find((story: { id: number }) => story.id === first.data.id)).not.toHaveProperty("permissionRecord");
  expect((await request(`/member-stories/${first.data.id}/withdraw`, member, "POST")).status).toBe(403);
  const withdrawn = await request(`/member-stories/${first.data.id}/withdraw`, owner, "POST");
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.data.withdrawnAt).toBeTruthy();
  expect((await request(`/member-stories/${first.data.id}/withdraw`, owner, "POST")).status).toBe(404);
  const publicAfter = await request("/member-stories");
  expect(publicAfter.data.some((story: { id: number }) => story.id === first.data.id)).toBe(false);
  expect(publicAfter.data.some((story: { id: number }) => story.id === second.data.id)).toBe(true);
});