import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { GetPendingMembershipInvoiceHistoryResponse } from "@workspace/api-zod";

const state = vi.hoisted(() => ({
  getUser: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: state.getUser } },
}));
vi.mock("@workspace/db", () => ({
  pool: { query: state.query },
  db: {},
  usersTable: {},
}));
vi.mock("../lib/stripeClient", () => ({
  getUncachableStripeClient: vi.fn(() => { throw new Error("Read-only view must not call Stripe"); }),
  getStripeSync: vi.fn(),
}));

let server: Server;
let url: string;
beforeAll(async () => {
  const { default: router } = await import("./membership");
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error: vi.fn() } as unknown as express.Request["log"];
    next();
  });
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server.on("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP server");
  url = `http://127.0.0.1:${address.port}/membership/pending-invoice-history`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  state.getUser.mockReset().mockImplementation(async (id: string) => ({ publicMetadata: { role: id } }));
  state.query.mockReset().mockResolvedValue({ rows: [] });
});
function request(role?: string, query = "") {
  return fetch(`${url}${query}`, { headers: role ? { "x-test-user": role } : {} });
}
const row = (id = 1) => ({
  id, clerk_id: "private-member", stripe_subscription_id: "sub_private",
  invoice_history_retry_count: 4, invoice_history_retry_at: new Date("2026-10-03T12:00:00Z"),
  // Private values must never be projected even if returned by a DB driver.
  customer_email: "private@example.invalid", failed_months: 2, last_failed_invoice: "in_private",
});

test.each([undefined, "member", "editor", "unknown"])("denies %s without reading pending records", async role => {
  const response = await request(role);
  expect(response.status).toBe(role ? 403 : 401);
  expect(state.query).not.toHaveBeenCalled();
  expect(JSON.stringify(await response.json())).not.toContain("private-member");
});
test.each(["owner", "admin"])("%s sees only recovery identifiers and retry state", async role => {
  state.query.mockResolvedValue({ rows: [row()] });
  const response = await request(role);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    memberships: [{
      checkoutId: 1, memberId: "private-member", subscriptionId: "sub_private",
      retryAttempts: 4, nextRetryAt: "2026-10-03T12:00:00.000Z",
    }],
    nextCursor: null,
  });
  const [sql, params] = state.query.mock.calls[0];
  expect(sql).toContain("status = 'forfeited' AND kind = 'founding' AND invoice_history_pending");
  expect(sql).toContain("ORDER BY id LIMIT 51");
  expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/);
  expect(params).toEqual([0]);
  expect(state.query).toHaveBeenCalledTimes(1);
});
test("pages without hiding records after the first 50", async () => {
  state.query.mockResolvedValueOnce({ rows: Array.from({ length: 51 }, (_, i) => row(i + 1)) });
  const first = GetPendingMembershipInvoiceHistoryResponse.parse(await (await request("owner")).json());
  expect(first.memberships).toHaveLength(50);
  expect(first.nextCursor).toBe(50);
  state.query.mockResolvedValueOnce({ rows: [row(51)] });
  const second = GetPendingMembershipInvoiceHistoryResponse.parse(await (await request("owner", "?after=50")).json());
  expect(state.query.mock.calls[1][1]).toEqual([50]);
  expect(second.memberships[0].checkoutId).toBe(51);
  expect(second.nextCursor).toBeNull();
});
test("represents missing schedule and subscription explicitly", async () => {
  state.query.mockResolvedValue({ rows: [{ ...row(), stripe_subscription_id: null, invoice_history_retry_at: null }] });
  const body = GetPendingMembershipInvoiceHistoryResponse.parse(await (await request("admin")).json());
  expect(body.memberships[0]).toMatchObject({ subscriptionId: null, nextRetryAt: null });
});
test("empty queue is a successful empty page", async () => {
  expect(await (await request("owner")).json()).toEqual({ memberships: [], nextCursor: null });
});
test.each(["-1", "1.5", "no", "9007199254740992"])("rejects invalid cursor %s", async cursor => {
  expect((await request("owner", `?after=${cursor}`)).status).toBe(400);
  expect(state.query).not.toHaveBeenCalled();
});
test("fails closed when staff role cannot be verified", async () => {
  state.getUser.mockRejectedValue(new Error("Clerk unavailable"));
  expect((await request("owner")).status).toBe(503);
  expect(state.query).not.toHaveBeenCalled();
});
test("database outages return an error, not an empty or stale queue", async () => {
  state.query.mockRejectedValue(new Error("DB unavailable"));
  const response = await request("owner");
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error: "Pending invoice history is unavailable. Try again later." });
});