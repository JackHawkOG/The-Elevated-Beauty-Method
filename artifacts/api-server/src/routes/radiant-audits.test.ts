import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, radiantAuditsTable, radiantAuditHistoryTable, usersTable } from "@workspace/db";
import { ensureRadiantAuditSchema } from "../lib/ensure-radiant-audit-schema";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
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
let server: Server;
let baseUrl: string;

async function request(method: string, body?: object, user = account, path = "") {
  const response = await fetch(`${baseUrl}/users/me/radiant-audit${path}`, {
    method,
    headers: { "x-test-user": user, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: response.status === 204 ? {} : await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Audit integration tests must only run against a development database");
  }
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
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const user of [account, otherAccount]) {
    await db.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, user));
    await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user));
    await db.delete(usersTable).where(eq(usersTable.clerkId, user));
  }
  await pool.end();
});

test("first save and later retake are classified by persisted account history", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "test trend",
    masteryGoal: "test goal",
    researchTime: "test time",
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
  expect(history.map(entry => entry.masteryGoal)).toEqual(["updated goal", "test goal"]);
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
    .toEqual(new Set(["test goal", "updated goal", "third goal", "simultaneous A", "simultaneous B"]));
});

test("members can remove earlier submissions without deleting the latest or another member's answers", async () => {
  const answers = {
    routineChecks: ["skincare-consistency"],
    valuesChecks: ["quality-over-price"],
    beautyTrend: "private trend",
    masteryGoal: "private goal",
    researchTime: "one hour",
  };
  await request("PUT", answers, otherAccount);
  const otherHistory = (await request("GET", undefined, otherAccount, "/history")).data as unknown as Array<{ id: number }>;
  expect(otherHistory).toHaveLength(1);
  const otherId = otherHistory[0].id;

  expect((await request("DELETE", undefined, account, `/history/${otherId}`)).status).toBe(404);
  expect((await request("GET", undefined, otherAccount, "/history")).data).toHaveLength(1);
  for (const invalid of ["abc", "0", "1.5", "999999999999999999999"]) {
    expect((await request("DELETE", undefined, account, `/history/${invalid}`)).status).toBe(400);
  }
  expect((await request("DELETE", undefined, account, "/history/999999")).status).toBe(404);

  const before = (await request("GET", undefined, account, "/history")).data as unknown as Array<{ id: number }>;
  expect(before.length).toBeGreaterThan(1);
  const latest = (await request("GET", undefined, account)).data;
  expect((await request("DELETE", undefined, account, `/history/${before[0].id}`)).status).toBe(204);
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