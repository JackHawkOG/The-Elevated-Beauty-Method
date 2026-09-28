import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import pinoHttp from "pino-http";
import { logger } from "../lib/logger";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, activityTable, announcementsTable } from "@workspace/db";
import { requireDevelopmentDatabase } from "./test-development-database";
import { ensureAnnouncementSchema } from "../lib/ensure-announcement-schema";

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: async (id: string) => ({
    publicMetadata: { role: id === "review-owner" ? "owner" : id === "review-admin" ? "admin" : "member" },
  }) } },
}));

let server: Server;
let base: string;
const posts: number[] = [];
const feeds: number[] = [];
const title = `Historical review ${randomUUID()}`;

async function request(path: string, user?: string, method = "GET", body?: object) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(user ? { "x-test-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`${method} ${path} ${response.status}: ${text.slice(0, 1200)}`);
  return { status: response.status, data: JSON.parse(text) as any, cache: response.headers.get("cache-control") };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureAnnouncementSchema();
  const { default: routes } = await import("./announcement-activity-review");
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json(), routes);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  base = `http://127.0.0.1:${address.port}`;
  const [first, second] = await db.insert(announcementsTable).values([
    { title, body: "First historical post", authorName: "Legacy" },
    { title, body: "Second historical post", authorName: "Legacy" },
  ]).returning();
  posts.push(first.id, second.id);
  const [candidate] = await db.insert(activityTable).values({
    type: "announcement", description: "posted an announcement",
    actorName: "Legacy", entityTitle: title,
  }).returning();
  feeds.push(candidate.id);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    if (feeds.length) await db.delete(activityTable).where(inArray(activityTable.id, feeds));
    if (posts.length) await db.delete(announcementsTable).where(inArray(announcementsTable.id, posts));
  } finally {
    await pool.end();
  }
});

test("staff sees ambiguous full records; only independently evidenced, current unassigned links succeed", async () => {
  expect((await request("/announcements/activity-review")).status).toBe(401);
  expect((await request("/announcements/activity-review", "review-member")).status).toBe(403);
  const list = await request("/announcements/activity-review", "review-owner");
  expect(list.status).toBe(200);
  expect(list.cache).toContain("no-store");
  const item = list.data.find((row: { announcementId: number }) => row.announcementId === posts[0]);
  expect(item.body).toBe("First historical post");
  expect(item.candidates).toEqual([expect.objectContaining({ id: feeds[0], sourceAnnouncementId: null })]);
  const path = `/announcements/${posts[0]}/activity-review`;
  const payload = { activityId: feeds[0], revision: item.revision, evidence: "Independent publication ledger entry identifies post one and feed row", independentlyVerified: true };
  expect((await request(path, undefined, "POST", payload)).status).toBe(401);
  expect((await request(path, "review-member", "POST", payload)).status).toBe(403);
  expect((await request(path, "review-owner", "POST", { ...payload, independentlyVerified: false })).status).toBe(400);
  expect((await request(path, "review-owner", "POST", { ...payload, evidence: "Title matches" })).status).toBe(400);
  expect((await request(path, "review-owner", "POST", { ...payload, revision: "f".repeat(64) })).status).toBe(409);
  const attached = await request(path, "review-owner", "POST", payload);
  expect(attached.status).toBe(200);
  expect(attached.data).toMatchObject({ announcementId: posts[0], activityId: feeds[0] });
  const [row] = await db.select().from(activityTable).where(inArray(activityTable.id, feeds));
  expect(row.sourceEvidence).toBe(payload.evidence);
  expect(row.sourceReviewedBy).toBe("review-owner");
  expect(row.sourceReviewedAt).toBeInstanceOf(Date);
  const other = list.data.find((entry: { announcementId: number }) => entry.announcementId === posts[1]);
  expect((await request(`/announcements/${posts[1]}/activity-review`, "review-admin", "POST", {
    ...payload, revision: other.revision,
  })).status).toBe(409);
  expect((await request(path, "review-owner", "POST", payload)).status).toBe(409);
  const fresh = await request("/announcements/activity-review", "review-admin");
  expect(fresh.data.find((entry: { announcementId: number }) => entry.announcementId === posts[0])).toBeUndefined();
  expect(fresh.data.find((entry: { announcementId: number }) => entry.announcementId === posts[1]).candidates[0].sourceAnnouncementId).toBe(posts[0]);
});