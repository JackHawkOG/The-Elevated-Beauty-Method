import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { requireDevelopmentDatabase } from "./test-development-database";

const { schema } = vi.hoisted(() => ({
  schema: `conversion_${process.pid}_${Date.now()}`,
}));

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
}));
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  jitProvisionUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
// Exercise the actual route SQL with concurrent PostgreSQL connections, but
// keep every fixture out of the app's tables and background membership sweeps.
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    pool: {
      query: (sql: string, params: unknown[]) => actual.pool.query(
        sql.replaceAll("membership_checkouts", `"${schema}".membership_checkouts`), params,
      ),
    },
  };
});

let server: Server | undefined;
let baseUrl: string;
let created = false;
let actual: typeof import("@workspace/db");

beforeAll(async () => {
  requireDevelopmentDatabase();
  actual = await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  await actual.pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await actual.pool.query(`CREATE TABLE "${schema}".membership_checkouts (
    id bigserial PRIMARY KEY, clerk_id text NOT NULL, kind text NOT NULL,
    status text NOT NULL, stripe_session_id text UNIQUE,
    conversion_claimed boolean NOT NULL DEFAULT false
  )`);
  const { default: router } = await import("./membership");
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (created) await actual.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
});

async function claim(checkoutSessionId: unknown, user = "member") {
  const response = await fetch(`${baseUrl}/membership/conversion-receipt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify({ checkoutSessionId }),
  });
  const body = await response.json() as { kind?: string | null; error?: string };
  return { status: response.status, cache: response.headers.get("cache-control"), body };
}

test.each(["founding", "standard"])("%s receipt grants one claim across simultaneous and repeated links", async kind => {
  const member = `member-${kind}`;
  const session = `cs_${kind}`;
  await actual.pool.query(
    `INSERT INTO "${schema}".membership_checkouts (clerk_id, kind, status, stripe_session_id)
     VALUES ($1, $2, 'confirmed', $3)`, [member, kind, session],
  );
  expect((await claim(session, "other-member")).body).toEqual({ kind: null });
  expect((await claim("cs_unrelated", member)).body).toEqual({ kind: null });
  expect((await claim(session, "")).status).toBe(401);
  expect((await claim("", member)).status).toBe(400);
  expect((await claim("x".repeat(256), member)).status).toBe(400);
  const results = await Promise.all(Array.from({ length: 6 }, () => claim(session, member)));
  expect(results.filter(result => result.body.kind === kind)).toHaveLength(1);
  expect(results.filter(result => result.body.kind === null)).toHaveLength(5);
  for (const result of results) {
    expect(result.status).toBe(200);
    expect(result.cache).toBe("private, no-store");
    expect(Object.keys(result.body)).toEqual(["kind"]);
  }
  expect((await claim(session, member)).body).toEqual({ kind: null });
});

test("pending, forfeited, and an older confirmed checkout cannot consume the current receipt", async () => {
  await actual.pool.query(
    `INSERT INTO "${schema}".membership_checkouts (clerk_id, kind, status, stripe_session_id)
     VALUES ('changing', 'standard', 'confirmed', 'cs_old'),
            ('changing', 'standard', 'pending', 'cs_current'),
            ('ended', 'founding', 'forfeited', 'cs_ended')`,
  );
  expect((await claim("cs_old", "changing")).body).toEqual({ kind: null });
  expect((await claim("cs_current", "changing")).body).toEqual({ kind: null });
  expect((await claim("cs_ended", "ended")).body).toEqual({ kind: null });
  await actual.pool.query(`UPDATE "${schema}".membership_checkouts SET status = 'confirmed' WHERE stripe_session_id = 'cs_current'`);
  expect((await claim("cs_current", "changing")).body).toEqual({ kind: "standard" });
  const old = await actual.pool.query(`SELECT conversion_claimed FROM "${schema}".membership_checkouts WHERE stripe_session_id = 'cs_old'`);
  expect(old.rows[0].conversion_claimed).toBe(false);
});