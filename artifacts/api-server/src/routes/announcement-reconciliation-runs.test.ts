import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { db, announcementReconciliationRunsTable, pool } from "@workspace/db";

const auth = vi.hoisted(() => ({ fail: false }));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: async (role: string) => {
    if (auth.fail) throw new Error("Role service unavailable");
    return { publicMetadata: { role } };
  } } },
}));

const rows = [{
  id: 51, version: 1, recordedAt: new Date("2026-10-03T12:00:00Z"),
  repairedIds: [2], review: [{ announcementId: 1, activityIds: [3], reason: "different author" }],
}];
const query = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() };
let select: ReturnType<typeof vi.spyOn>;
let server: Server;
let base: string;

beforeAll(async () => {
  select = vi.spyOn(db, "select").mockReturnValue(query as never);
  // Test actual route order: the generic announcement-ID route must not catch
  // the archive path. No route writes or real database reads are performed.
  const { default: router } = await import("./index");
  const app = express();
  app.use((_req, _res, next) => { _req.log = { error: vi.fn() } as never; next(); });
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  base = `http://127.0.0.1:${address.port}/api/announcements/reconciliation-runs`;
});
beforeEach(() => {
  auth.fail = false;
  select.mockClear();
  query.from.mockReset().mockReturnValue(query);
  query.where.mockReset().mockReturnValue(query);
  query.orderBy.mockReset().mockReturnValue(query);
  query.limit.mockReset().mockResolvedValue(rows);
});
afterAll(async () => {
  select.mockRestore();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pool.end();
});

async function request(role?: string, queryString = "") {
  return fetch(`${base}${queryString}`, { headers: role ? { "x-test-user": role } : {} });
}

test("guests, members, and unverified staff receive no archive data", async () => {
  for (const [role, status] of [[undefined, 401], ["member", 403]] as const) {
    const response = await request(role);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: expect.any(String) });
  }
  auth.fail = true;
  const failed = await request("owner");
  expect(failed.status).toBe(503);
  expect(failed.headers.get("cache-control")).toBe("private, no-store");
  expect(await failed.json()).toEqual({ error: "Unable to verify staff access" });
  expect(select).not.toHaveBeenCalled();
});

test.each(["owner", "admin"])("%s can read exact archived evidence without running repairs", async role => {
  const response = await request(role);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual([{ ...rows[0], recordedAt: rows[0].recordedAt.toISOString() }]);
  expect(query.from).toHaveBeenCalledWith(announcementReconciliationRunsTable);
  expect(query.limit).toHaveBeenCalledWith(50);
  expect(query.orderBy).toHaveBeenCalledOnce();
  expect(query.where).toHaveBeenCalledWith(undefined);
});

test("cursor paging is validated and returns an empty final page", async () => {
  for (const value of ["0", "-1", "1.5", "bad", "2147483648", "1&beforeId=2"]) {
    expect((await request("owner", `?beforeId=${value}`)).status).toBe(400);
  }
  expect(select).not.toHaveBeenCalled();
  query.limit.mockResolvedValue([]);
  const response = await request("admin", "?beforeId=51");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  expect(query.where.mock.calls[0][0]).toBeDefined();
});