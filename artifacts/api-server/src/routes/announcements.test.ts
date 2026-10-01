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
const pagingActor = `test-announcement-pager-${run}`;
const title = `Announcement test ${run}`;
const failingTitle = `${title} blocked`;
const legacyTitle = `${title} historical`;
let server: Server;
let baseUrl: string;
const ids: number[] = [];
let started = false;

async function post(
  key: string | null,
  body: { title: string; body: string; pinned?: boolean } = { title, body: "An update" },
  actor = user,
) {
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
  const [{ default: router }, { default: dashboardRouter }] = await Promise.all([
    import("./announcements"), import("./dashboard"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: () => undefined } as unknown as typeof req.log;
    next();
  });
  app.use(router, dashboardRouter);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Write failed" });
  });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await db.insert(usersTable).values([
    { clerkId: user, email: `${user}@example.invalid`, displayName: "Announcement Test" },
    { clerkId: pagingActor, email: `${pagingActor}@example.invalid`, displayName: "Paging Actor" },
  ]);
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    if (!started) return;
    const actorRows = await db.select({ id: announcementsTable.id }).from(announcementsTable)
      .where(inArray(announcementsTable.actorId, [user, pagingActor, `another-user-${run}`]));
    const ownedIds = [...new Set([...ids, ...actorRows.map(row => row.id)])];
    if (ownedIds.length) {
      await db.delete(activityTable).where(inArray(activityTable.sourceAnnouncementId, ownedIds));
      await db.delete(announcementsTable).where(inArray(announcementsTable.id, ownedIds));
    }
    await db.delete(activityTable).where(eq(activityTable.entityTitle, legacyTitle));
    await db.delete(usersTable).where(inArray(usersTable.clerkId, [user, pagingActor]));
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
  await db.insert(activityTable).values({
    type: "announcement", description: "posted an announcement", actorName: "Earlier author",
    entityTitle: legacyTitle,
  });
  const feedResponse = await fetch(`${baseUrl}/dashboard/recent-activity`);
  expect(feedResponse.status).toBe(200);
  const feed = await feedResponse.json() as Array<{ entityTitle: string; sourceAnnouncementId: number | null }>;
  expect(feed.some(item => item.entityTitle === title && item.sourceAnnouncementId === results[0].data.id)).toBe(true);
  expect(feed.find(item => item.entityTitle === legacyTitle)?.sourceAnnouncementId).toBeNull();
  const postResponse = await fetch(`${baseUrl}/announcements/${results[0].data.id}`);
  expect(postResponse.status).toBe(200);
  expect((await postResponse.json() as { title: string }).title).toBe(title);
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

test("keyset pages retain fixture order while another actor posts pinned and unpinned announcements", async () => {
  const pinnedTieAt = new Date(Date.now() - 60 * 60 * 1000);
  const pinnedOlderAt = new Date(pinnedTieAt.getTime() - 60 * 60 * 1000);
  const unpinnedTieAt = new Date(pinnedTieAt.getTime() + 30 * 60 * 1000);
  const fixtures = await db.insert(announcementsTable).values([
    ...Array.from({ length: 3 }, (_, i) => ({
      title: `${title} pinned tie ${i}`, body: "Paging fixture", authorName: "Test",
      pinned: true, createdAt: pinnedTieAt,
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      title: `${title} pinned older ${i}`, body: "Paging fixture", authorName: "Test",
      pinned: true, createdAt: pinnedOlderAt,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      title: `${title} unpinned tie ${i}`, body: "Paging fixture", authorName: "Test",
      // Unpinned posts remain below every pinned post, even with a newer timestamp.
      pinned: false, createdAt: unpinnedTieAt,
    })),
  ]).returning();
  ids.push(...fixtures.map(row => row.id));
  const expected = [...fixtures]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
      b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    .map(row => row.id);
  const fixtureIds = new Set(expected);
  const pageSize = 2;
  const readPage = async (after?: number) => {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (after !== undefined) query.set("after", String(after));
    const response = await fetch(`${baseUrl}/announcements?${query}`);
    expect(response.status).toBe(200);
    return await response.json() as Array<{ id: number; pinned: boolean; createdAt: string }>;
  };
  const visited: Array<{ id: number; pinned: boolean; createdAt: string }> = [];
  const record = (page: typeof visited) => {
    visited.push(...page);
    expect(new Set(visited.map(row => row.id)).size).toBe(visited.length);
    expect(visited).toEqual([...visited].sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
    ));
  };

  const firstPage = await readPage();
  expect(firstPage.length).toBe(pageSize);
  record(firstPage);

  const pinnedTitle = `${title} posted pinned`;
  const pinnedPost = await post(randomUUID(), { title: pinnedTitle, body: "Posted during paging", pinned: true }, pagingActor);
  expect(pinnedPost.status).toBe(201);
  expect(pinnedPost.data.id).toBeDefined();
  ids.push(pinnedPost.data.id!);

  const secondPage = await readPage(firstPage.at(-1)!.id);
  expect(secondPage.length).toBe(pageSize);
  record(secondPage);

  const unpinnedTitle = `${title} posted unpinned`;
  const unpinnedPost = await post(randomUUID(), { title: unpinnedTitle, body: "Posted during paging", pinned: false }, pagingActor);
  expect(unpinnedPost.status).toBe(201);
  expect(unpinnedPost.data.id).toBeDefined();
  ids.push(unpinnedPost.data.id!);
  const postedRows = await db.select().from(announcementsTable)
    .where(inArray(announcementsTable.id, [pinnedPost.data.id!, unpinnedPost.data.id!]));
  expect(postedRows.map(row => [row.actorId, row.pinned]).sort()).toEqual([
    [pagingActor, false],
    [pagingActor, true],
  ].sort());

  let cursor = secondPage.at(-1)!.id;
  while (!expected.every(id => visited.some(row => row.id === id))) {
    const page = await readPage(cursor);
    expect(page.length).toBeGreaterThan(0);
    record(page);
    cursor = page.at(-1)!.id;
  }

  const fixtureRows = visited.filter(row => fixtureIds.has(row.id));
  expect(fixtureRows.map(row => row.id)).toEqual(expected);
  expect(fixtureRows.map(row => row.pinned)).toEqual([
    true, true, true, true, true, false, false, false,
  ]);
  expect(fixtureRows[0].createdAt).toBe(fixtureRows[1].createdAt);
  expect(fixtureRows[0].id).toBeGreaterThan(fixtureRows[1].id);
  expect(fixtureRows[5].id).toBeGreaterThan(fixtureRows[6].id);
  expect(visited.some(row => row.id === unpinnedPost.data.id)).toBe(true);

  for (const query of ["limit=0", "limit=101", "after=-1", "after=2147483648", "after=999999999"]) {
    expect((await fetch(`${baseUrl}/announcements?${query}`)).status).toBe(400);
  }
});