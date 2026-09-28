import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool, radiantAuditsTable, radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditDraftsTable, usersTable } from "@workspace/db";
import { AUDIT_RECEIPT_RETENTION_MS, ensureRadiantAuditSchema, purgeExpiredRadiantAuditReceipts } from "../lib/ensure-radiant-audit-schema";
import { requireDevelopmentDatabase } from "./test-development-database";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (!req.header("x-test-user")) {
      _res.status(401).json({ error: "Sign in required" });
      return;
    }
    req.userId = req.header("x-test-user");
    next();
  },
  jitProvisionUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.dbUserId = 1;
    next();
  },
}));

const account = `audit-test-${randomUUID()}`;
const otherAccount = `audit-test-${randomUUID()}`;
const retryAccount = `audit-test-${randomUUID()}`;
const draftAccount = `audit-test-${randomUUID()}`;
const expiryAccount = `audit-test-${randomUUID()}`;
const competingAccount = `audit-test-${randomUUID()}`;
const draftRevisions = new Map<string, string>();
let server: Server;
let baseUrl: string;
let databaseSafe = false;

async function request(method: string, body?: object, user = account, path = "") {
  const response = await fetch(`${baseUrl}/users/me/radiant-audit${path}`, {
    method,
    headers: {
      "x-test-user": user,
      ...(path === "/draft" ? { "x-audit-draft-owner": user } : {}),
      ...(path === "/draft" && method === "PUT" ? { "x-audit-draft-baseline": "none" } : {}),
      ...(path === "/draft" && method !== "GET" ? { "x-audit-draft-revision": draftRevisions.get(user) ?? "none" } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
  if (path === "/draft" && response.ok) {
    if (data && typeof data.updatedAt === "string") draftRevisions.set(user, data.updatedAt);
    if (data && typeof data.discardedAt === "string") draftRevisions.set(user, data.discardedAt);
    if (method === "GET" && data === null) draftRevisions.set(user, "none");
    if (method === "DELETE") {
      const marker = await request("GET", undefined, user, "/draft");
      if (typeof marker.data.discardedAt === "string") draftRevisions.set(user, marker.data.discardedAt);
    }
  }
  return { status: response.status, data };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  databaseSafe = true;
  await ensureRadiantAuditSchema();
  const { default: router } = await import("./radiant-audits");
  const app = express();
  app.use(express.json(), router);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  await db.insert(usersTable).values({
    clerkId: account,
    displayName: "Audit test",
    email: `${account}@example.invalid`,
  });
  await db.insert(usersTable).values({
    clerkId: otherAccount,
    displayName: "Other audit test",
    email: `${otherAccount}@example.invalid`,
  });
  await db.insert(usersTable).values({
    clerkId: retryAccount,
    displayName: "Retry audit test",
    email: `${retryAccount}@example.invalid`,
  });
  await db.insert(usersTable).values({
    clerkId: draftAccount,
    displayName: "Draft audit test",
    email: `${draftAccount}@example.invalid`,
  });
  await db.insert(usersTable).values({
    clerkId: expiryAccount,
    displayName: "Expiry audit test",
    email: `${expiryAccount}@example.invalid`,
  });
  await db.insert(usersTable).values({
    clerkId: competingAccount,
    displayName: "Competing draft test",
    email: `${competingAccount}@example.invalid`,
  });
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!databaseSafe) return;
    for (const user of [account, otherAccount, retryAccount, draftAccount, expiryAccount, competingAccount]) {
      await db.delete(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, user));
      await db.delete(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, user));
      await db.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, user));
      await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user));
      await db.delete(usersTable).where(eq(usersTable.clerkId, user));
    }
  } finally {
    await pool.end();
  }
});

test("competing devices cannot replace or delete a newer draft without reading its revision", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: [],
    beautyTrend: "device one",
    masteryGoal: "",
    researchTime: "",
  };
  const write = async (revision: string, body: object, method = "PUT") => {
    const response = await fetch(`${baseUrl}/users/me/radiant-audit/draft`, {
      method,
      headers: {
        "x-test-user": competingAccount,
        "x-audit-draft-owner": competingAccount,
        "x-audit-draft-baseline": "none",
        "x-audit-draft-revision": revision,
        "content-type": "application/json",
      },
      body: method === "PUT" ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as Record<string, unknown> };
  };
  const [first, second] = await Promise.all([
    write("none", answers),
    write("none", { ...answers, beautyTrend: "device two" }),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 409]);
  const winning = first.status === 200 ? first : second;
  const oldVersion = winning.data!.updatedAt as string;
  expect((await write("none", answers)).status).toBe(409);
  expect((await write("none", {}, "DELETE")).status).toBe(409);
  const next = await write(oldVersion, { ...answers, beautyTrend: "newer version" });
  expect(next.status).toBe(200);
  expect(next.data!.updatedAt).not.toBe(oldVersion);
  expect((await write(oldVersion, answers)).status).toBe(409);
  expect((await write(oldVersion, {}, "DELETE")).status).toBe(409);
  expect((await request("GET", undefined, competingAccount, "/draft")).data).toMatchObject({ beautyTrend: "newer version" });
  expect((await write(next.data!.updatedAt as string, {}, "DELETE")).status).toBe(204);
  expect((await write(next.data!.updatedAt as string, answers)).status).toBe(409);
});

test("unfinished drafts belong only to their owner, expire, and are removed on submit", async () => {
  const draft = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: [],
    beautyTrend: "private unfinished answer",
    masteryGoal: "",
    researchTime: "",
  };
  const unauthenticated = await fetch(`${baseUrl}/users/me/radiant-audit/draft`);
  expect(unauthenticated.status).toBe(401);
  expect((await request("PUT", draft, draftAccount, "/draft")).status).toBe(200);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toMatchObject(draft);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toHaveProperty("updatedAt");
  expect((await request("GET", undefined, otherAccount, "/draft")).data).toBeNull();
  expect((await request("PUT", { ...draft, beautyTrend: "other member" }, otherAccount, "/draft")).status).toBe(200);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toMatchObject(draft);
  expect((await request("DELETE", undefined, otherAccount, "/draft")).status).toBe(204);
  expect((await request("GET", undefined, otherAccount, "/draft")).data).toHaveProperty("discardedAt");
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toMatchObject(draft);
  for (const method of ["PUT", "DELETE"]) {
    const stolen = await fetch(`${baseUrl}/users/me/radiant-audit/draft`, {
      method,
      headers: { "x-test-user": otherAccount, "x-audit-draft-owner": draftAccount, "content-type": "application/json" },
      body: method === "PUT" ? JSON.stringify(draft) : undefined,
    });
    expect(stolen.status).toBe(409);
  }
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toMatchObject(draft);
  expect((await request("PUT", { ...draft, routineChecks: ["invalid"] }, draftAccount, "/draft")).status).toBe(400);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toMatchObject(draft);
  await db.update(radiantAuditDraftsTable).set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(radiantAuditDraftsTable.clerkId, draftAccount));
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toBeNull();
  await request("PUT", draft, draftAccount, "/draft");
  const complete = { ...draft, masteryGoal: "goal", researchTime: "one hour" };
  expect((await request("PUT", { ...complete, submissionId: randomUUID() }, draftAccount)).status).toBe(200);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toBeNull();
  await request("PUT", draft, draftAccount, "/draft");
  expect((await request("DELETE", undefined, draftAccount, "/draft")).status).toBe(204);
  expect((await request("GET", undefined, draftAccount, "/draft")).data).toHaveProperty("discardedAt");
  expect(await db.select().from(radiantAuditDraftsTable)
    .where(eq(radiantAuditDraftsTable.clerkId, draftAccount))).toMatchObject([
      { answers: { discardedAt: expect.any(String) } },
    ]);
});

test("a committed save with a lost response can be retried without creating history", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "private trend",
    masteryGoal: "private goal",
    researchTime: "one hour",
  };
  const firstId = randomUUID();
  // Simulate the client losing the response: submit, but do not consume its body.
  const lost = await fetch(`${baseUrl}/users/me/radiant-audit`, {
    method: "PUT",
    headers: { "x-test-user": retryAccount, "content-type": "application/json" },
    body: JSON.stringify({ ...answers, submissionId: firstId }),
  });
  expect(lost.status).toBe(200);
  const firstSaved = (await request("GET", undefined, retryAccount)).data;
  const firstRetry = await request("PUT", { ...answers, submissionId: firstId }, retryAccount);
  expect(firstRetry.data).toEqual({ audit: firstSaved, completionKind: "first_time" });
  expect((await request("GET", undefined, retryAccount, "/history")).data).toEqual([]);
  expect((await request("GET", undefined, retryAccount)).data).toEqual(firstSaved);

  const secondId = randomUUID();
  const secondAnswers = { ...answers, masteryGoal: "new goal" };
  const retake = await request("PUT", { ...answers, masteryGoal: "updated goal" });
  expect(retake.data).toMatchObject({ completionKind: "retake", audit: secondAnswers });
  const history = (await request("GET", undefined, account, "/history")).data as unknown as Array<Record<string, unknown>>;
  expect(history).toHaveLength(1);
  expect((await request("PUT", { ...secondAnswers, submissionId: secondId }, retryAccount)).data).toEqual(retake.data);
  expect((await request("PUT", { ...answers, submissionId: firstId }, retryAccount)).data).toEqual(firstRetry.data);
  expect((await request("GET", undefined, retryAccount, "/history")).data).toEqual(history);
  expect((await request("GET", undefined, retryAccount)).data).toEqual(retake.data.audit);

  const conflict = await request("PUT", { ...answers, masteryGoal: "changed", submissionId: firstId }, retryAccount);
  expect(conflict.status).toBe(409);
  expect((await request("GET", undefined, retryAccount, "/history")).data).toEqual(history);

  // Identical answers with a new ID are still a deliberate new retake.
  const identicalRetake = await request("PUT", { ...secondAnswers, submissionId: randomUUID() }, retryAccount);
  expect(identicalRetake.data).toHaveProperty("completionKind", "retake");
  expect((await request("GET", undefined, retryAccount, "/history")).data).toHaveLength(2);

  const concurrentId = randomUUID();
  const concurrentAnswers = { ...answers, masteryGoal: "concurrent retry" };
  const [a, b] = await Promise.all([
    request("PUT", { ...concurrentAnswers, submissionId: concurrentId }, retryAccount),
    request("PUT", { ...concurrentAnswers, submissionId: concurrentId }, retryAccount),
  ]);
  expect(a.status).toBe(200);
  expect(b.data).toEqual(a.data);
  expect((await request("GET", undefined, retryAccount, "/history")).data).toHaveLength(3);
});

test("expired receipts are purged without deleting Audits or history; their IDs can create new retakes", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "private trend",
    masteryGoal: "private goal",
    researchTime: "one hour",
  };
  const expiredId = randomUUID();
  const recentId = randomUUID();
  expect((await request("PUT", { ...answers, submissionId: expiredId }, expiryAccount)).status).toBe(200);
  const newer = await request("PUT", { ...answers, masteryGoal: "new goal", submissionId: recentId }, expiryAccount);
  expect(newer.status).toBe(200);
  const current = (await request("GET", undefined, expiryAccount)).data;
  const history = (await request("GET", undefined, account, "/history")).data as unknown as Array<Record<string, unknown>>;

  const now = new Date();
  await db.update(radiantAuditSubmissionsTable)
    .set({ createdAt: new Date(now.getTime() - AUDIT_RECEIPT_RETENTION_MS - 1000) })
    .where(and(
      eq(radiantAuditSubmissionsTable.clerkId, expiryAccount),
      eq(radiantAuditSubmissionsTable.submissionId, expiredId),
    ));
  await purgeExpiredRadiantAuditReceipts(now);
  const receipts = await db.select().from(radiantAuditSubmissionsTable)
    .where(eq(radiantAuditSubmissionsTable.clerkId, expiryAccount));
  expect(receipts.map(receipt => receipt.submissionId)).toEqual([recentId]);
  expect((await request("GET", undefined, expiryAccount)).data).toEqual(current);
  expect((await request("GET", undefined, expiryAccount, "/history")).data).toEqual(history);
  expect((await request("PUT", { ...answers, masteryGoal: "new goal", submissionId: recentId }, expiryAccount)).data)
    .toEqual(newer.data);

  // Once purged, the former ID is no longer a replay and can create a retake.
  const replay = await request("PUT", { ...answers, submissionId: expiredId }, expiryAccount);
  expect(replay.status).toBe(200);
  expect(replay.data).toMatchObject({ completionKind: "retake", audit: answers });
  expect((await request("GET", undefined, expiryAccount, "/history")).data).toHaveLength(2);
  expect((await request("GET", undefined, expiryAccount)).data).toEqual(replay.data.audit);
});

test("first save and later retake are classified by persisted account history", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "private trend",
    masteryGoal: "private goal",
    researchTime: "one hour",
  };
  const first = await request("PUT", answers);
  expect(first.status).toBe(200);
  expect(first.data).toMatchObject({ completionKind: "first_time", audit: answers });
  expect(Object.keys(first.data)).toEqual(["audit", "completionKind"]);

  const reloaded = await request("GET");
  expect(reloaded.status).toBe(200);
  expect(reloaded.data).toMatchObject(answers);
  expect(reloaded.data).not.toHaveProperty("completionKind");

  const retake = await request("PUT", { ...answers, masteryGoal: "updated goal" });
  expect(retake.status).toBe(200);
  expect(retake.data).toMatchObject({
    completionKind: "retake",
    audit: { masteryGoal: "updated goal" },
  });
  expect((await request("GET")).data).toHaveProperty("masteryGoal", "updated goal");

  const firstHistory = await request("GET", undefined, account, "/history");
  expect(firstHistory.status).toBe(200);
  expect(firstHistory.data).toHaveLength(1);
  expect(firstHistory.data[0]).toMatchObject({ ...answers, routineScore: 1, valuesScore: 1 });
  expect(firstHistory.data[0]).toHaveProperty("completedAt", reloaded.data.completedAt);

  const secondRetake = await request("PUT", { ...answers, masteryGoal: "third goal" });
  expect(secondRetake.data).toHaveProperty("completionKind", "retake");
  const history = (await request("GET", undefined, account, "/history")).data as unknown as Array<Record<string, unknown>>;
  expect(history).toHaveLength(2);
  expect(history.map(entry => entry.masteryGoal)).toEqual(["updated goal", "private goal"]);
  expect((await request("GET")).data).toHaveProperty("masteryGoal", "third goal");

  expect((await request("GET", undefined, otherAccount)).data).toBeNull();
  expect((await request("GET", undefined, otherAccount, "/history")).data).toEqual([]);
  expect((await request("PUT", { ...answers, masteryGoal: "other member" }, otherAccount)).data)
    .toHaveProperty("completionKind", "first_time");
  expect((await request("GET", undefined, otherAccount, "/history")).data).toEqual([]);
  expect((await request("GET", undefined, account, "/history")).data).toHaveLength(2);

  const invalid = await request("PUT", { ...answers, masteryGoal: "" });
  expect(invalid.status).toBe(400);
  expect((await request("GET", undefined, account, "/history")).data).toHaveLength(2);

  const [simultaneousA, simultaneousB] = await Promise.all([
    request("PUT", { ...answers, masteryGoal: "simultaneous A" }),
    request("PUT", { ...answers, masteryGoal: "simultaneous B" }),
  ]);
  expect([simultaneousA.status, simultaneousB.status]).toEqual([200, 200]);
  const final = (await request("GET")).data;
  const finalHistory = (await request("GET", undefined, account, "/history")).data as unknown as Array<Record<string, unknown>>;
  expect(finalHistory).toHaveLength(4);
  expect(new Set([final.masteryGoal, ...finalHistory.map(entry => entry.masteryGoal)]))
    .toEqual(new Set(["private goal", "updated goal", "third goal", "simultaneous A", "simultaneous B"]));
});

test("members can remove earlier submissions without deleting the latest or another member's answers", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "private trend",
    masteryGoal: "private goal",
    researchTime: "one hour",
  };
  await request("PUT", { ...answers, masteryGoal: "other member's retake" }, otherAccount);
  const otherHistory = (await request("GET", undefined, otherAccount, "/history")).data;
  expect(otherHistory).toHaveLength(1);
  if (!Array.isArray(otherHistory) || typeof otherHistory[0]?.id !== "number") {
    throw new Error("Expected an audit history entry with a numeric ID");
  }
  const otherId = (otherHistory as unknown as Array<{ id: number }>)[0].id;

  expect((await request("DELETE", undefined, account, `/history/${otherId}`)).status).toBe(404);
  expect((await request("GET", undefined, otherAccount, "/history")).data).toHaveLength(1);
  for (const invalid of ["abc", "0", "1.5", "999999999999999999999"]) {
    expect((await request("DELETE", undefined, account, `/history/${invalid}`)).status).toBe(400);
  }
  expect((await request("DELETE", undefined, account, "/history/999999")).status).toBe(404);

  const before = (await request("GET", undefined, account, "/history")).data as unknown as Array<{ id: number }>;
  expect(before.length).toBeGreaterThan(1);
  const latest = (await request("GET")).data;
  expect((await request("DELETE", undefined, account, `/history/${before[0].id}`)).status).toBe(204);
  expect(await db.select().from(radiantAuditSubmissionsTable)
    .where(eq(radiantAuditSubmissionsTable.clerkId, account))).toEqual([]);
  const remaining = (await request("GET", undefined, account, "/history")).data as unknown as Array<{ id: number }>;
  expect(remaining).toHaveLength(before.length - 1);
  expect(remaining.map(entry => entry.id)).not.toContain(before[0].id);
  expect((await request("GET", undefined, account)).data).toEqual(latest);

  expect((await request("DELETE", undefined, account, "/history")).status).toBe(204);
  expect((await request("DELETE", undefined, account, "/history")).status).toBe(204);
  expect((await request("GET", undefined, account, "/history")).data).toEqual([]);
  expect((await request("GET", undefined, account)).data).toEqual(latest);
  expect((await request("GET", undefined, otherAccount, "/history")).data).toHaveLength(1);
});

test("deleting the current Audit leaves earlier history intact and does not affect another member", async () => {
  const latest = (await request("GET")).data;
  const otherLatest = (await request("GET", undefined, otherAccount)).data;
  const otherHistory = (await request("GET", undefined, otherAccount, "/history")).data;
  expect(latest).not.toBeNull();
  expect(otherLatest).not.toBeNull();
  const preservedAnswers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "new trend",
    masteryGoal: "fresh start",
    researchTime: "one hour",
  };
  await request("PUT", preservedAnswers);
  const ownHistory = (await request("GET", undefined, account, "/history")).data;
  expect(ownHistory).toHaveLength(1);

  expect((await request("DELETE")).status).toBe(204);
  expect(await db.select().from(radiantAuditSubmissionsTable)
    .where(eq(radiantAuditSubmissionsTable.clerkId, account))).toEqual([]);
  expect((await request("GET")).data).toBeNull();
  expect((await request("GET", undefined, account, "/history")).data).toEqual(ownHistory);
  expect((await request("GET", undefined, otherAccount)).data).toEqual(otherLatest);
  expect((await request("GET", undefined, otherAccount, "/history")).data).toEqual(otherHistory);
  expect((await request("DELETE")).status).toBe(404);

  const newAudit = await request("PUT", preservedAnswers);
  expect(newAudit.data).toMatchObject({ completionKind: "first_time", audit: preservedAnswers });
  expect((await request("GET")).data).toMatchObject(preservedAnswers);
  expect((await request("GET", undefined, account, "/history")).data).toEqual(ownHistory);

  const earlier = (await request("GET", undefined, otherAccount, "/history")).data as unknown as Array<{ id: number }>;
  expect(earlier).toHaveLength(1);
  expect((await request("DELETE", undefined, otherAccount)).status).toBe(204);
  expect((await request("GET", undefined, otherAccount)).data).toBeNull();
  expect((await request("GET", undefined, otherAccount, "/history")).data).toEqual(otherHistory);
  expect((await request("DELETE", undefined, otherAccount, `/history/${earlier[0].id}`)).status).toBe(204);
  expect((await request("GET", undefined, otherAccount, "/history")).data).toEqual([]);
});
