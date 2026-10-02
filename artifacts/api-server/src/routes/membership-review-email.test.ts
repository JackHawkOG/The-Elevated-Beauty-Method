import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  pool: { query: mocks.query, connect: async () => ({ query: mocks.query, release: mocks.release }) },
}));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: mocks.getUser } },
}));
import router from "./membership-review-email";
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { warn: vi.fn() } as unknown as typeof req.log; next(); });
  app.use(router);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test listener unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.stubEnv("BILLING_REVIEW_APP_URL", "https://example.invalid");
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.getUser.mockReset().mockResolvedValue({
    publicMetadata: { role: "owner" }, primaryEmailAddressId: "primary",
    emailAddresses: [{ id: "primary", verification: { status: "verified" } }],
  });
});
async function request(method = "GET", body?: unknown, signedIn = true) {
  return fetch(`${baseUrl}/membership/review-email-preference`, {
    method, headers: { "Content-Type": "application/json", ...(signedIn ? { "x-test-user": "owner-fixture" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
test("sign-in and current owner role are required; admins and members cannot opt in", async () => {
  expect((await request("GET", undefined, false)).status).toBe(401);
  for (const role of ["member", "admin"]) {
    mocks.getUser.mockResolvedValue({ publicMetadata: { role } });
    expect((await request()).status).toBe(403);
    expect((await request("PUT", { enabled: true })).status).toBe(403);
  }
  expect(mocks.query).not.toHaveBeenCalled();
});
test("default is off, GET reflects durable preference, and responses are not cacheable", async () => {
  let response = await request();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ enabled: false, available: true });
  mocks.query.mockResolvedValue({ rows: [{ enabled: true }] });
  response = await request();
  expect(await response.json()).toEqual({ enabled: true, available: true });
});
test("opt-in saves only the authenticated owner, with no arbitrary recipient", async () => {
  expect((await request("PUT", { enabled: true, email: "other@example.invalid" })).status).toBe(400);
  expect((await request("PUT", { enabled: "true" })).status).toBe(400);
  const response = await request("PUT", { enabled: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ enabled: true, available: true });
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO membership_review_email_preferences"), ["owner-fixture", true]);
  expect(mocks.query).toHaveBeenCalledWith("COMMIT");
});
test("opt-out suppresses pending emails in the preference transaction", async () => {
  expect((await request("PUT", { enabled: false })).status).toBe(200);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'suppressed'"), ["owner-fixture"]);
});
test("unverified email and missing link reject opt-in but never block opt-out", async () => {
  mocks.getUser.mockResolvedValue({ publicMetadata: { role: "owner" }, emailAddresses: [] });
  expect((await request("PUT", { enabled: true })).status).toBe(400);
  expect((await request("PUT", { enabled: false })).status).toBe(200);
  mocks.getUser.mockResolvedValue({
    publicMetadata: { role: "owner" }, primaryEmailAddressId: "primary",
    emailAddresses: [{ id: "primary", verification: { status: "verified" } }],
  });
  vi.stubEnv("BILLING_REVIEW_APP_URL", "");
  expect((await request("PUT", { enabled: true })).status).toBe(503);
  expect((await request("PUT", { enabled: false })).status).toBe(200);
});
test("identity or database outages fail explicitly", async () => {
  mocks.getUser.mockRejectedValue(new Error("private"));
  expect((await request()).status).toBe(503);
  mocks.getUser.mockResolvedValue({ publicMetadata: { role: "owner" }, emailAddresses: [] });
  mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
  expect((await request()).status).toBe(503);
});