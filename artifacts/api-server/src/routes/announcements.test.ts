import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { activityTable, announcementsTable, db, pool, usersTable } from "@workspace/db";
import { ensureAnnouncementSchema } from "../lib/ensure-announcement-schema";
import { requireDevelopmentDatabase } from "./test-development-database";

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: async () => ({ publicMetadata: { role: "member" } }) } },
}));

const run = randomUUID();
const user = `test-announcement-${run}`;
const title = `Announcement test ${run}`;
const failingTitle = `${title} blocked`;
let server: Server;
let baseUrl: string;
const ids: number[] = [];
let started = false;

async function post(key: string | null, body = { title, body: "An update" }, actor = user) {
  const response = await fetch(`${baseUrl}/announcements`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": actor, ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as { id?: number } };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureAnnouncementSchema();
  started = true;
  const { default: router } = await import("./announcements");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: () => undefined } as unknown as typeof req.log;
    next();
  });
  app.use(router);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Write failed" });
  });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await db.insert(usersTable).values({ clerkId: user, email: `${user}@example.invalid`, displayName: "Announcement Test" });
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    if (!started) return;
    await db.delete(activityTable).where(inArray(activityTable.entityTitle, [title, failingTitle]));
    if (ids.length) await db.delete(announcementsTable).where(inArray(announcementsTable.id, ids));
    await db.delete(usersTable).where(eq(usersTable.clerkId, user));
  } finally {
    await pool.end();
  }
});

test("retries and simultaneous requests keep one post and one feed item", async () => {
  expect((await post(null)).status).toBe(400);
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 4 }, () => post(key)));
  expect(results.map(result => result.status).sort()).toEqual([200, 200, 200, 201]);
  expect(new Set(results.map(result => result.data.id)).size).toBe(1);
  ids.push(results[0].data.id!);
  expect((await post(key, { title, body: "Different update" })).status).toBe(409);
  expect((await post(key, { title, body: "An update" }, `another-user-${run}`)).status).toBe(201);
  // The second actor's row is separate, even with the same key.
  const rows = await db.select().from(announcementsTable).where(eq(announcementsTable.requestKey, key));
  ids.push(...rows.filter(row => !ids.includes(row.id)).map(row => row.id));
  expect(rows).toHaveLength(2);
  const linked = await db.select().from(activityTable).where(and(
    eq(activityTable.actorName, "Announcement Test"), eq(activityTable.entityTitle, title),
  ));
  expect(linked).toHaveLength(1);
  expect(linked[0].sourceAnnouncementId).toBe(results[0].data.id);
  const other = rows.find(row => row.id !== results[0].data.id)!;
  expect(await db.select().from(activityTable).where(eq(activityTable.sourceAnnouncementId, other.id))).toHaveLength(1);
  // A changed display name or a repeated title cannot affect an explicit source link.
  await db.update(activityTable).set({ actorName: "Previous display name" }).where(eq(activityTable.id, linked[0].id));
  expect((await db.select().from(activityTable).where(eq(activityTable.id, linked[0].id)))[0].sourceAnnouncementId)
    .toBe(results[0].data.id);
  await expect(db.insert(activityTable).values({
    type: "announcement", description: "posted an announcement",
    actorName: "Previous display name", entityTitle: title,
    sourceAnnouncementId: results[0].data.id!,
  })).rejects.toThrow();
  expect(await db.select().from(activityTable).where(eq(activityTable.sourceAnnouncementId, results[0].data.id!)))
    .toHaveLength(1);
});

test("an activity write failure rolls back the post and permits a clean retry", async () => {
  const key = randomUUID();
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE activity ADD CONSTRAINT announcement_test_guard CHECK (entity_title <> '${failingTitle}')`);
    const failed = await post(key, { title: failingTitle, body: "An update" });
    expect(failed.status).toBe(500);
    expect(await db.select().from(announcementsTable).where(eq(announcementsTable.requestKey, key))).toHaveLength(0);
  } finally {
    await client.query("ALTER TABLE activity DROP CONSTRAINT IF EXISTS announcement_test_guard");
    client.release();
  }
  const retried = await post(key, { title: failingTitle, body: "An update" });
  expect(retried.status).toBe(201);
  ids.push(retried.data.id!);
  const linked = await db.select().from(activityTable).where(and(
    eq(activityTable.actorName, "Announcement Test"), eq(activityTable.entityTitle, failingTitle),
  ));
  expect(linked).toHaveLength(1);
  expect(linked[0].sourceAnnouncementId).toBe(retried.data.id);
});