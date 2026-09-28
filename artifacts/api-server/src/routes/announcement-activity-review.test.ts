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
import { reconcileAnnouncementActivity } from "../lib/reconcile-announcement-activity";

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
  // Exercise the same route order as the running API, including the generic
  // /announcements/:announcementId handler.
  const { default: routes } = await import("./index");
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

test("only an owner can correct a manual link; correction preserves evidence and resists stale or duplicate assignments", async () => {
  const listPath = "/announcements/activity-review/corrections";
  const path = `${listPath}/${feeds[0]}`;
  const before = await request(listPath, "review-owner");
  expect(before.status).toBe(200);
  expect(before.cache).toContain("no-store");
  expect((await request(listPath, "review-admin")).status).toBe(403);
  const original = before.data.records.find((entry: { activityId: number }) => entry.activityId === feeds[0]);
  expect(original.sourceAnnouncementId).toBe(posts[0]);
  const unlink = { revision: original.revision, announcementId: null, rationale: "The publication ledger now disproves the initial pairing." };
  expect((await request(path, undefined, "POST", unlink)).status).toBe(401);
  expect((await request(path, "review-admin", "POST", unlink)).status).toBe(403);
  expect((await request(path, "review-owner", "POST", { ...unlink, rationale: "mistake" })).status).toBe(400);
  expect((await request(path, "review-owner", "POST", { ...unlink, revision: "f".repeat(64) })).status).toBe(409);
  const unlinked = await request(path, "review-owner", "POST", unlink);
  expect(unlinked.status).toBe(200);
  expect(unlinked.data).toMatchObject({ sourceAnnouncementId: null, sourceReviewedBy: null });
  expect(unlinked.data.history[0]).toMatchObject({
    fromAnnouncementId: posts[0], toAnnouncementId: null,
    previousReviewedBy: "review-owner", previousEvidence: "Independent publication ledger entry identifies post one and feed row",
    correctedBy: "review-owner", rationale: unlink.rationale,
  });
  expect((await request(path, "review-owner", "POST", unlink)).status).toBe(409);
  await reconcileAnnouncementActivity();
  const [stillUnlinked] = await db.select().from(activityTable).where(inArray(activityTable.id, feeds));
  expect(stillUnlinked.sourceAnnouncementId).toBeNull();
  const queue = await request("/announcements/activity-review", "review-owner");
  const correctedItem = queue.data.find((entry: { announcementId: number }) => entry.announcementId === posts[0]);
  expect(correctedItem.reason).toBe("previous feed assignment was corrected");
  expect(correctedItem.candidates).toEqual([]);
  expect((await request(`/announcements/${posts[0]}/activity-review`, "review-admin", "POST", {
    activityId: feeds[0], revision: correctedItem.revision,
    evidence: "A misleading ledger extract incorrectly claims the original pairing",
    independentlyVerified: true,
  })).status).toBe(409);
  const [notReattached] = await db.select().from(activityTable).where(inArray(activityTable.id, feeds));
  expect(notReattached.sourceAnnouncementId).toBeNull();
  const unlinkedHistory = await request(listPath, "review-owner");
  expect(unlinkedHistory.data.records.find((entry: { activityId: number }) => entry.activityId === feeds[0]).history).toHaveLength(1);

  const reassign = { revision: unlinked.data.revision, announcementId: posts[1],
    rationale: "A second dated ledger page identifies the other announcement.",
    evidence: "Publication ledger page two identifies the second post and this feed row",
    independentlyVerified: true };
  expect((await request(path, "review-owner", "POST", { ...reassign, independentlyVerified: false })).status).toBe(400);
  const reassigned = await request(path, "review-owner", "POST", reassign);
  expect(reassigned.status).toBe(200);
  expect(reassigned.data.sourceAnnouncementId).toBe(posts[1]);
  expect(reassigned.data.history).toHaveLength(2);
  expect(reassigned.data.history[0].previousReviewedBy).toBe("review-owner");
  expect(reassigned.data.history[1]).toMatchObject({ fromAnnouncementId: null, toAnnouncementId: posts[1], evidence: reassign.evidence });
  expect((await request(path, "review-owner", "POST", reassign)).status).toBe(409);

  const [extra] = await db.insert(activityTable).values({
    type: "announcement", description: "posted an announcement", actorName: "Legacy", entityTitle: title,
  }).returning();
  feeds.push(extra.id);
  const competing = await request("/announcements/activity-review", "review-admin");
  const item = competing.data.find((entry: { announcementId: number }) => entry.announcementId === posts[0]);
  expect((await request(`/announcements/${posts[0]}/activity-review`, "review-admin", "POST", {
    activityId: extra.id, revision: item.revision, evidence: "Independent ledger identifies the first post and this second feed row", independentlyVerified: true,
  })).status).toBe(200);
  expect((await request(path, "review-owner", "POST", {
    ...reassign, revision: reassigned.data.revision, announcementId: posts[0],
  })).status).toBe(409);
  const after = await request(listPath, "review-owner");
  expect(after.data.records.find((entry: { activityId: number }) => entry.activityId === feeds[0]).history).toHaveLength(2);
});