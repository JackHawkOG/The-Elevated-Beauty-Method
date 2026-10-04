import { afterEach, expect, test, vi } from "vitest";
import express from "express";
import pinoHttp from "pino-http";
import type { Server } from "node:http";
const auth = vi.hoisted(() => ({ id: "owner-fixture", role: "owner", unavailable: false }));
vi.mock("@workspace/db", () => ({
  db: new Proxy({}, { get() { throw new Error("No live database in guide record route tests"); } }),
  routineGuideClaimsTable: {}, routineGuideDeliveriesTable: {}, routineGuideRateLimitsTable: {},
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!auth.id) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.userId = auth.id; next();
  },
}));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUser: async () => {
  if (auth.unavailable) throw new Error("fixture ownership outage");
  return { publicMetadata: { role: auth.role } };
} } } }));
import { createRoutineGuideRouter } from "./routine-guide";
import { GuideRecordConflict } from "../lib/routine-guide-records";
let server: Server | undefined;
afterEach(async () => {
  auth.id = "owner-fixture"; auth.role = "owner"; auth.unavailable = false;
  if (server) {
    await new Promise<void>((resolve, reject) => { server!.close(error => error ? reject(error) : resolve()); server!.closeIdleConnections(); });
    server = undefined;
  }
});
const review = { email: "person@example.invalid", claims: 1, deliveries: 1, emailCounters: 1, activeDelivery: false, revision: "a".repeat(64) };
async function fixture() {
  const records = {
    lookup: vi.fn(async () => review),
    remove: vi.fn(async () => ({ email: review.email, erased: true })),
  };
  const send = vi.fn(async () => "accepted" as const);
  const app = express();
  app.use(pinoHttp({ level: "silent" }), express.json(), createRoutineGuideRouter({ records, send }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  return { records, send, post: (operation: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/routine-guide/records/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) };
}
test.each(["member", "editor", "staff"])("role %s cannot look up or erase guide records", async role => {
  const f = await fixture(); auth.role = role;
  expect((await f.post("lookup", { email: review.email })).status).toBe(403);
  expect((await f.post("remove", { email: review.email, confirmationEmail: review.email, revision: review.revision })).status).toBe(403);
  expect(f.records.lookup).not.toHaveBeenCalled(); expect(f.records.remove).not.toHaveBeenCalled();
});
test("anonymous and unverifiable owners cannot access guide records", async () => {
  const f = await fixture(); auth.id = "";
  expect((await f.post("lookup", { email: review.email })).status).toBe(401);
  auth.id = "owner-fixture"; auth.unavailable = true;
  expect((await f.post("remove", { email: review.email, confirmationEmail: review.email, revision: review.revision })).status).toBe(503);
  expect(f.records.remove).not.toHaveBeenCalled();
});
test("lookup normalizes addresses; invalid inputs and wrong confirmation cannot delete", async () => {
  const f = await fixture();
  const found = await f.post("lookup", { email: " Person@Example.Invalid " });
  expect(found.status).toBe(200); expect(found.headers.get("cache-control")).toBe("no-store");
  expect(f.records.lookup).toHaveBeenCalledWith(review.email);
  expect((await f.post("lookup", { email: "bad" })).status).toBe(400);
  expect((await f.post("remove", { email: review.email, confirmationEmail: "other@example.invalid", revision: review.revision })).status).toBe(400);
  expect(f.records.remove).not.toHaveBeenCalled();
});
test("removal does not return success until commit resolves and never calls sender", async () => {
  const f = await fixture();
  let finish!: () => void;
  let entered!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; });
  f.records.remove.mockImplementationOnce(async () => {
    entered(); await new Promise<void>(resolve => { finish = resolve; });
    return { email: review.email, erased: true };
  });
  let responded = false;
  const pending = f.post("remove", { email: review.email, confirmationEmail: review.email, revision: review.revision }).then(response => { responded = true; return response; });
  try {
    await called; expect(responded).toBe(false);
  } finally { finish(); }
  const response = await pending;
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ email: review.email, erased: true });
  expect(f.send).not.toHaveBeenCalled();
});
test("conflicts and failed transactions never report erasure", async () => {
  const f = await fixture();
  f.records.remove.mockRejectedValueOnce(new GuideRecordConflict("Review again"));
  expect((await f.post("remove", { email: review.email, confirmationEmail: review.email, revision: review.revision })).status).toBe(409);
  f.records.remove.mockRejectedValueOnce(new Error("fixture rollback"));
  const response = await f.post("remove", { email: review.email, confirmationEmail: review.email, revision: review.revision });
  expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("erased");
  expect(f.send).not.toHaveBeenCalled();
});