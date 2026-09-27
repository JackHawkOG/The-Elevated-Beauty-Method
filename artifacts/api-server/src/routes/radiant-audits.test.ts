import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, radiantAuditsTable, usersTable } from "@workspace/db";

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
let server: Server;
let baseUrl: string;

async function request(method: string, body?: object) {
  const response = await fetch(`${baseUrl}/users/me/radiant-audit`, {
    method,
    headers: { "x-test-user": account, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Audit integration tests must only run against a development database");
  }
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
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, account));
  await db.delete(usersTable).where(eq(usersTable.clerkId, account));
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
});