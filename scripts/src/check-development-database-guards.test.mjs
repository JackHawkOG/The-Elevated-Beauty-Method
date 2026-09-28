import assert from "node:assert/strict";
import test from "node:test";
import { checkLiveSuite, checkMaintenanceCommand, checkSuite } from "./check-development-database-guards.mjs";

const imports = `import { db, pool } from "@workspace/db";
import { requireDevelopmentDatabase } from "./test-development-database";`;

test("rejects fixture writes and schema setup without an early guard", () => {
  assert.match(checkSuite(`${imports}
    beforeAll(async () => { await db.insert(usersTable).values({}); requireDevelopmentDatabase(); });`)[0], /beforeAll/);
  assert.match(checkSuite(`import { ensureMembershipSchema } from "../lib/ensure-membership-schema";
    beforeAll(async () => { await ensureMembershipSchema(); });`)[0], /import/);
  assert.ok(checkSuite(`${imports}
    test("writes", async () => { await pool.query("INSERT INTO users VALUES (1)"); });`).length);
});

test("accepts beforeAll and per-test guards, including named each callbacks", () => {
  assert.deepEqual(checkSuite(`${imports}
    beforeAll(async () => { requireDevelopmentDatabase(); await db.insert(usersTable).values({}); });
    test("writes", async () => { await pool.query("DELETE FROM users"); });`), []);
  assert.deepEqual(checkSuite(`${imports}
    test.each(["migration"] as const)("works %s", repair);
    async function repair() { requireDevelopmentDatabase(); await pool.connect(); }`), []);
});

test("does not treat mock database unit tests as real database writes", () => {
  assert.deepEqual(checkSuite(`import { pool } from "@workspace/db";
    vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));
    test("mock", async () => { await pool.query("DELETE FROM users"); });`), []);
  assert.deepEqual(checkSuite(`import type { PoolClient } from "@workspace/db";
    const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
    test("mock", async () => { await client.query("INSERT INTO users"); });`), []);
  assert.deepEqual(checkSuite(`import { db } from "@workspace/db";
    vi.mock("@workspace/db", () => ({ db: { insert: vi.fn() } }));
    beforeAll(async () => { await ensureMembershipSchema(); });
    test("mock", () => db.insert(usersTable));`), []);
});

test("rejects module-scope writes despite a guarded setup hook", () => {
  assert.match(checkSuite(`${imports}
    const pending = db.delete(usersTable);
    beforeAll(() => { requireDevelopmentDatabase(); });`)[0], /module scope/);
  assert.match(checkSuite(`${imports}
    db.insert(usersTable).values({});
    beforeAll(() => { requireDevelopmentDatabase(); });`)[0], /module scope/);
});

test("rejects a setup hook that runs before a later guard", () => {
  assert.match(checkSuite(`${imports}
    beforeAll(async () => { await pool.query("DELETE FROM users"); });
    beforeAll(() => { requireDevelopmentDatabase(); });`)[0], /beforeAll/);
});

test("rejects unguarded setup writes even when tests guard themselves or only read", () => {
  for (const testBody of [
    `requireDevelopmentDatabase(); await pool.query("DELETE FROM users");`,
    `expect(true).toBe(true);`,
  ]) {
    assert.ok(checkSuite(`${imports}
      beforeAll(async () => { await db.insert(usersTable).values({}); });
      test("case", async () => { ${testBody} });`)
      .some(problem => problem.includes("beforeAll")));
  }
  assert.ok(checkSuite(`${imports}
    beforeEach(async () => { await pool.query("DELETE FROM users"); });
    test("case", async () => { requireDevelopmentDatabase(); await pool.query("DELETE FROM users"); });`)
    .some(problem => problem.includes("beforeEach")));
});

test("ignores pure tests in a suite whose database test guards itself", () => {
  assert.deepEqual(checkSuite(`${imports}
    test("constant", () => { expect(1).toBe(1); });
    test("writes", async () => { requireDevelopmentDatabase(); await pool.query("DELETE FROM users"); }, 30000);`), []);
});

test("accepts a first beforeEach guard, but not one following an unguarded beforeAll", () => {
  assert.deepEqual(checkSuite(`${imports}
    beforeEach(() => { requireDevelopmentDatabase(); });
    test("writes", async () => { await pool.query("DELETE FROM users"); });`), []);
  assert.ok(checkSuite(`${imports}
    beforeAll(async () => { await pool.query("DELETE FROM users"); });
    beforeEach(() => { requireDevelopmentDatabase(); });
    test("writes", async () => { await pool.query("DELETE FROM users"); });`).length);
});

test("detects direct pg pools and workspace database namespace imports", () => {
  assert.ok(checkSuite(`import { Pool } from "pg";
    const connection = new Pool();
    test("writes", async () => { await connection.query("INSERT INTO users VALUES (1)"); });`).length);
  assert.ok(checkSuite(`import * as database from "@workspace/db";
    test("writes", async () => { await database.db.insert(usersTable).values({}); });`).length);
});

const liveImports = `import { test } from "@playwright/test";
  import { requireAuditDevelopment } from "./radiant-audit-fixtures";`;

test("live database fixtures require a guard before setup and cleanup", () => {
  const fixture = `const { db } = await import("../../../lib/db/src/index");
    await db.delete(usersTable);`;
  assert.deepEqual(checkLiveSuite(`${liveImports}
    test("cleanup", async () => {
      test.setTimeout(120_000);
      requireAuditDevelopment();
      try { await doBrowserWork(); } finally { ${fixture} }
    });`), []);
  for (const body of [
    `try { await doBrowserWork(); } finally { ${fixture} }`,
    `await clerkSetup(); requireAuditDevelopment(); try { await doBrowserWork(); } finally { ${fixture} }`,
  ]) {
    assert.match(checkLiveSuite(`${liveImports} test("cleanup", async () => { ${body} });`)[0], /guard/);
  }
  assert.match(checkLiveSuite(`${liveImports}
    test.beforeEach(async () => { await client.users.createUser({}); });
    test("cleanup", async () => { requireAuditDevelopment(); ${fixture} });`)[0], /beforeEach/);
  assert.match(checkLiveSuite(`${liveImports}
    client.users.createUser({});
    test("cleanup", async () => { requireAuditDevelopment(); ${fixture} });`)[0], /module scope/);
  assert.match(checkLiveSuite(`${liveImports}
    import { db } from "@workspace/db";
    const pending = db.delete(usersTable);
    test("cleanup", async () => { requireAuditDevelopment(); await pending; });`)[0], /module scope/);
  assert.match(checkLiveSuite(`${liveImports}
    test.describe("group", () => {
      test("unguarded nested cleanup", async () => { ${fixture} });
    });`)[0], /guard/);
});

test("recognized imported guards protect live specs, not lookalike names", () => {
  const write = `const { pool } = await import("../../../lib/db/src/index");
    await pool.query("DELETE FROM users");`;
  assert.deepEqual(checkLiveSuite(`${liveImports}
    test("writes", async () => { requireAuditDevelopment(); ${write} });`), []);
  assert.deepEqual(checkLiveSuite(`import { test } from "@playwright/test";
    import { requireCommunityDevelopment } from "./community-fixtures";
    test("writes", async () => { requireCommunityDevelopment(); ${write} });`), []);
  assert.deepEqual(checkLiveSuite(`import { test } from "@playwright/test";
    import { requireStoryDevelopment } from "./member-stories-fixtures";
    test("writes", async () => { requireStoryDevelopment(); ${write} });`), []);
  assert.ok(checkLiveSuite(`import { test } from "@playwright/test";
    function requireAuditDevelopment() {}
    test("writes", async () => { requireAuditDevelopment(); ${write} });`).length);
  assert.ok(checkLiveSuite(`import { test } from "@playwright/test";
    import { requireAuditDevelopment } from "./other-fixtures";
    test("writes", async () => { requireAuditDevelopment(); ${write} });`).length);
});

test("mock-only browser checks do not need database guards", () => {
  assert.deepEqual(checkLiveSuite(`import { test } from "@playwright/test";
    test("mock", async ({ page }) => {
      await page.route("**/api/users", route => route.fulfill({ json: [] }));
    });`), []);
  assert.deepEqual(checkLiveSuite(`import { test } from "@playwright/test";
    import { db } from "@workspace/db";
    vi.mock("@workspace/db", () => ({ db: { delete: vi.fn() } }));
    test("mock", async () => { await db.delete(usersTable); });`), []);
});

test("maintenance commands reject missing, fake, late, and module-scope guards", () => {
  const dbImport = `const { db } = await import("@workspace/db"); await db.delete(usersTable);`;
  const guard = `import { requireAuditDevelopment } from "./radiant-audit-fixtures";`;
  assert.match(checkMaintenanceCommand(`async function main() { ${dbImport} }`)[0], /guard/);
  assert.match(checkMaintenanceCommand(`function requireAuditDevelopment() {}
    async function main() { requireAuditDevelopment(); ${dbImport} }`)[0], /imported.*guard/);
  assert.match(checkMaintenanceCommand(`import { requireAuditDevelopment } from "./fake-fixtures";
    async function main() { requireAuditDevelopment(); ${dbImport} }`)[0], /imported.*guard/);
  assert.match(checkMaintenanceCommand(`${guard}
    async function main() { await loadClient(); requireAuditDevelopment(); ${dbImport} }`)[0], /before client/);
  assert.ok(checkMaintenanceCommand(`${guard}
    import { db } from "@workspace/db";
    async function main() { requireAuditDevelopment(); await db.delete(usersTable); }`)
    .some(issue => /dynamically/.test(issue)));
  assert.ok(checkMaintenanceCommand(`${guard}
    const connection = import("@workspace/db");
    async function main() { requireAuditDevelopment(); await connection; }`)
    .some(issue => /module scope/.test(issue)));
});

test("maintenance commands accept guarded cleanup and dry-run commands", () => {
  assert.deepEqual(checkMaintenanceCommand(`import { requireAuditDevelopment } from "./radiant-audit-fixtures";
    async function main() {
      const args = process.argv.slice(2);
      if (args.length > 1) { throw new Error("Usage"); }
      requireAuditDevelopment();
      const { db } = await import("@workspace/db");
      await db.transaction(async tx => { await tx.delete(usersTable); });
    }`), []);
  assert.deepEqual(checkMaintenanceCommand(`import { progressBrowserEnvironment } from "./member-progress-browser-environment";
    async function inspect() { const { db } = await import("@workspace/db"); await db.delete(usersTable); }
    async function main() {
      const run = confirmedRun(process.argv.slice(2));
      progressBrowserEnvironment();
      await inspect();
    }`), []);
  assert.deepEqual(checkMaintenanceCommand(`async function main() { console.log("No database"); }`), []);
});

test("Clerk-only maintenance cleanup still requires an early development guard", () => {
  const deletion = `await client.users.deleteUser(id);`;
  assert.match(checkMaintenanceCommand(`async function main() { ${deletion} }`)[0], /guard/);
  assert.ok(checkMaintenanceCommand(`import { requireAuditDevelopment } from "./radiant-audit-fixtures";
    async function main() { await client.users.deleteUser(id); requireAuditDevelopment(); }`)
    .some(issue => /before client/.test(issue)));
  assert.deepEqual(checkMaintenanceCommand(`import { requireAuditDevelopment } from "./radiant-audit-fixtures";
    async function main() { requireAuditDevelopment(); ${deletion} }`), []);
  assert.ok(checkMaintenanceCommand(`import { requireAuditDevelopment } from "./radiant-audit-fixtures";
    const pending = client.users.deleteUser(id);
    async function main() { requireAuditDevelopment(); await pending; }`)
    .some(issue => /module scope/.test(issue)));
});