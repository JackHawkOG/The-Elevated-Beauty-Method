import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkLiveSuite, checkMaintenanceCommand, checkSuite } from "./check-development-database-guards.mjs";
import { discoverLiveBrowserTests } from "./discover-live-browser-tests.mjs";

async function safetyFixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "browser-guard-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["scripts/src", "artifacts/api-server/src/routes", "artifacts/api-server/src/lib",
    "artifacts/edu-portal/tests"]) await mkdir(path.join(root, folder), { recursive: true });
  for (const name of ["check-development-database-guards.mjs", "discover-live-browser-tests.mjs"]) {
    await copyFile(new URL(name, import.meta.url), path.join(root, "scripts/src", name));
  }
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), path.join(root, "node_modules"), "dir");
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  return {
    root,
    run: () => spawnSync(process.execPath, ["scripts/src/check-development-database-guards.mjs"],
      { cwd: root, encoding: "utf8" }),
  };
}

const browserFixtureDir = "artifacts/edu-portal/tests/";
const liveConfigFixture = `import { defineConfig } from "@playwright/test";
  export default defineConfig({ testDir: "${browserFixtureDir}", testMatch: ["**/*.spec.ts", "**/*.spec.tsx"] });`;

test("safety command rejects differently named live writes, including nested TSX specs", async t => {
  for (const name of ["profile-edit.spec.ts", "nested/checkout.spec.tsx"]) {
    const f = await safetyFixture(t, {
      "playwright.account-live.config.ts": liveConfigFixture,
      [browserFixtureDir + name]: `import { test } from "@playwright/test";
        test("write", async ({ request }) => { await request.post("/api/users"); });`,
    });
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(name));
    assert.match(result.stderr, /development database guard/);
  }
});

test("discovery follows inherited selections, regexes and projects without executing configs", async t => {
  const f = await safetyFixture(t, {
    "playwright.base.config.ts": `export default {
      testDir: "${browserFixtureDir}", testMatch: /profile-edit\\.spec\\.tsx?$/,
      testIgnore: "**/ignored/**"
    };`,
    "playwright.account-live.config.ts": `import base from "./playwright.base.config";
      throw new Error("Do not execute configuration");
      export default { ...base, projects: [{}, { testMatch: "nested/payment.spec.tsx" }] };`,
    [browserFixtureDir + "profile-edit.spec.ts"]: "",
    [browserFixtureDir + "ignored/profile-edit.spec.ts"]: "",
    [browserFixtureDir + "nested/payment.spec.tsx"]: "",
    [browserFixtureDir + "mock-ui.spec.ts"]: "",
    [browserFixtureDir + "orphan-live.spec.ts"]: "",
  });
  assert.deepEqual((await discoverLiveBrowserTests(f.root)).map(filename => path.relative(f.root, filename)), [
    browserFixtureDir + "nested/payment.spec.tsx",
    browserFixtureDir + "orphan-live.spec.ts",
    browserFixtureDir + "profile-edit.spec.ts",
  ]);
});

test("differently named mock-only and guarded live specs still pass the command", async t => {
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": liveConfigFixture,
    [browserFixtureDir + "mock-ui.spec.ts"]: `import { test } from "@playwright/test";
      test("mock", async ({ page }) => {
        await page.route("**/api/**", route => route.fulfill({ json: {} }));
        await page.getByRole("button").click();
      });`,
    [browserFixtureDir + "profile-edit.spec.ts"]: `import { test } from "@playwright/test";
      import { requireAuditDevelopment } from "./radiant-audit-fixtures";
      test("write", async ({ request }) => {
        requireAuditDevelopment(); await request.post("/api/users");
      });`,
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safety check passed/);
});

test("a partial mock cannot exempt an unguarded differently named UI write", async t => {
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": liveConfigFixture,
    [browserFixtureDir + "profile-edit.spec.ts"]: `import { test } from "@playwright/test";
      test("write", async ({ page }) => {
        await page.route("**/api/users", route => route.fulfill({ json: {} }));
        await page.getByRole("button").click();
      });`,
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /profile-edit\.spec\.ts.*guard/);
});

test("unresolved live selections fail the command instead of silently skipping specs", async t => {
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": `export default { testMatch: process.env.LIVE_SPECS };`,
  });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot safely discover live browser tests/);
});

test("live configurations can select writes outside the legacy browser directory", async t => {
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": `export default { testDir: "other-browser-tests" };`,
    "other-browser-tests/account-edit.test.ts": `import { test } from "@playwright/test";
      test("write", async ({ request }) => { await request.patch("/api/users/me"); });`,
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /other-browser-tests\/account-edit\.test\.ts.*guard/);
});

test("malformed live configurations fail discovery", async t => {
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": `export default { testMatch: ["profile-edit.spec.ts"`,
  });
  await assert.rejects(discoverLiveBrowserTests(f.root), /Cannot safely parse live configuration/);
});

test("command uses Playwright's case-insensitive globs and includes dot-directories", async t => {
  const names = ["Profile.SPEC.ts", ".fixtures/profile.spec.ts"];
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": liveConfigFixture,
    ...Object.fromEntries(names.map(name => [browserFixtureDir + name, `import { test } from "@playwright/test";
      test("write", async ({ request }) => { await request.post("/api/users"); });`])),
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  for (const name of names) assert.ok(result.stderr.includes(name), result.stderr);
});

test("command covers all Playwright default module TSX and JSX extensions", async t => {
  const names = ["profile.spec.mtsx", "profile.spec.ctsx", "profile.spec.mjsx", "profile.spec.cjsx"];
  const f = await safetyFixture(t, {
    "playwright.account-live.config.ts": `export default { testDir: "${browserFixtureDir}" };`,
    ...Object.fromEntries(names.map(name => [browserFixtureDir + name, `import { test } from "@playwright/test";
      test("write", async ({ request }) => { await request.post("/api/users"); });`])),
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  for (const name of names) assert.ok(result.stderr.includes(name), result.stderr);
});

test("command resolves inherited test directories against the entry configuration", async t => {
  const f = await safetyFixture(t, {
    "configs/browser-base.ts": `export default { testDir: "browser-tests", testMatch: "*.spec.ts" };`,
    "playwright.account-live.config.ts": `import base from "./configs/browser-base";
      export default { ...base };`,
    // Both directories exist: inspecting the wrong one would silently pass.
    "configs/browser-tests/profile-edit.spec.ts": `import { test } from "@playwright/test";
      test("read", async ({ page }) => { await page.goto("/profile"); });`,
    "browser-tests/profile-edit.spec.ts": `import { test } from "@playwright/test";
      test("write", async ({ request }) => { await request.post("/api/users"); });`,
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /browser-tests\/profile-edit\.spec\.ts.*guard/);
  assert.ok(!result.stderr.includes("configs/browser-tests"));
});

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

test("browser-only UI writes require a real guard before any interaction", () => {
  const write = `await page.goto("/profile");
    await page.getByLabel("Name").fill("Fixture");
    await page.getByRole("button", { name: "Save" }).click();`;
  assert.match(checkLiveSuite(`${liveImports}
    test("save", async ({ page }) => { ${write} });`)[0], /guard/);
  assert.deepEqual(checkLiveSuite(`${liveImports}
    test("save", async ({ page }) => { requireAuditDevelopment(); ${write} });`), []);
  assert.match(checkLiveSuite(`${liveImports}
    test("save", async ({ page }) => { ${write} requireAuditDevelopment(); });`)[0], /guard/);
  assert.ok(checkLiveSuite(`import { test } from "@playwright/test";
    function requireAuditDevelopment() {}
    test("save", async ({ page }) => { requireAuditDevelopment(); ${write} });`).length);
});

test("browser-only HTTP writes and helper callbacks cannot escape classification", () => {
  for (const write of [
    `await request.post("/api/posts", { data: {} });`,
    `await page.request.put("/api/profile", { data: {} });`,
    `await context.request.patch("/api/profile", { data: {} });`,
    `await request.delete("/api/posts/1");`,
    `await fetch("/api/posts", { method: "POST", body: "{}" });`,
    `await page.evaluate(() => fetch("/api/profile", { "method": "PATCH" }));`,
    `await request.fetch("/api/profile", { method: verb });`,
  ]) {
    assert.match(checkLiveSuite(`${liveImports}
      test("write", async ({ page, request, context }) => { ${write} });`)[0], /guard/);
    assert.deepEqual(checkLiveSuite(`${liveImports}
      test("write", async ({ page, request, context }) => { requireAuditDevelopment(); ${write} });`), []);
  }
  assert.ok(checkLiveSuite(`${liveImports}
    async function save(page) { await page.getByRole("button", { name: "Save" }).click(); }
    async function run({ page }) { await save(page); }
    test.each(["one"])("writes %s", run, 30000);`).length);
  assert.deepEqual(checkLiveSuite(`${liveImports}
    async function run({ page }) { requireAuditDevelopment(); await page.locator("button").click(); }
    test.each(["one"])("writes %s", run, 30000);`), []);
});

test("only early complete non-forwarding API mocks exempt UI writes", () => {
  const write = `await page.getByRole("button", { name: "Save" }).click();`;
  for (const mock of [
    `await page.route("**/api/**", route => route.fulfill({ json: {} }));`,
    `await context.route("**/*", async route => { await route.abort(); });`,
  ]) {
    assert.deepEqual(checkLiveSuite(`${liveImports}
      test("mock", async ({ page, context }) => { ${mock} ${write} });`), []);
    assert.ok(checkLiveSuite(`${liveImports}
      test("late mock", async ({ page, context }) => { ${write} ${mock} });`).length);
    // Playwright request calls bypass browser route interception.
    assert.ok(checkLiveSuite(`${liveImports}
      test("API", async ({ page, context, request }) => { ${mock} await request.post("/api/posts"); });`).length);
  }
  for (const mock of [
    `await page.route("**/api/posts", route => route.fulfill({ json: {} }));`,
    `await page.route("**/api/**", route => route.continue());`,
    `await page.route("**/api/**", async route => { await route.fulfill({ response: await route.fetch() }); });`,
    `await page.route("**/api/**", route => { if (route.request().method() === "GET") return route.fulfill({ json: {} }); });`,
    `await page.route("**/api/**", route => route.fulfill({ json: {} }));
      await page.unrouteAll();`,
  ]) {
    assert.ok(checkLiveSuite(`${liveImports}
      test("not mock-only", async ({ page }) => { ${mock} ${write} });`).length);
  }
  // A mock in an unrelated test is not evidence that the writing test is mocked.
  assert.ok(checkLiveSuite(`${liveImports}
    test("mock", async ({ page }) => { await page.route("**/api/**", route => route.fulfill({ json: {} })); });
    test("live", async ({ page }) => { ${write} });`).length);
});

test("browser-only setup, cleanup and module writes require guards too", () => {
  for (const hook of ["beforeAll", "beforeEach", "afterAll", "afterEach"]) {
    assert.ok(checkLiveSuite(`${liveImports}
      test.${hook}(async ({ request }) => { await request.delete("/api/posts/1"); });
      test("read", async () => { requireAuditDevelopment(); });`).some(issue => issue.includes(hook)));
    assert.deepEqual(checkLiveSuite(`${liveImports}
      test.${hook}(async ({ request }) => { requireAuditDevelopment(); await request.delete("/api/posts/1"); });
      test("read", async () => { requireAuditDevelopment(); });`), []);
  }
  assert.ok(checkLiveSuite(`${liveImports}
    const pending = fetch("/api/posts", { method: "POST" });
    test("write", async () => { requireAuditDevelopment(); await pending; });`)
    .some(issue => /module scope/.test(issue)));
  assert.deepEqual(checkLiveSuite(`${liveImports}
    test("read", async ({ page, request }) => {
      await page.goto("/profile"); await request.get("/api/profile");
    });`), []);
});

test("expression-bodied callbacks and focused or skipped registrations are classified", () => {
  for (const registration of ["test", "test.only", "test.skip", "test.fixme"]) {
    for (const callback of [
      `async ({ request }) => request.post("/api/posts", { data: {} })`,
      `async ({ page }) => page.getByRole("button", { name: "Save" }).click()`,
      `async ({ page }) => { await page.getByRole("button", { name: "Save" }).click(); }`,
      `save`,
    ]) {
      assert.ok(checkLiveSuite(`${liveImports}
        const save = async ({ request }) => request.post("/api/posts");
        ${registration}("write", ${callback});`).some(issue => /guard/.test(issue)));
    }
    assert.deepEqual(checkLiveSuite(`${liveImports}
      ${registration}("write", async ({ page }) => {
        requireAuditDevelopment();
        await page.getByRole("button", { name: "Save" }).click();
      });`), []);
  }
  assert.ok(checkLiveSuite(`${liveImports}
    test.beforeEach(async ({ request }) => request.post("/api/posts"));
    test("read", async () => { requireAuditDevelopment(); });`)
    .some(issue => /beforeEach/.test(issue)));
  assert.deepEqual(checkLiveSuite(`${liveImports}
    test("write", async ({ request }) => {
      requireAuditDevelopment();
      test.skip(false, "conditional skip is not a test registration");
      await request.post("/api/posts");
    });`), []);
});

test("finite route mocks and mocks on a different page cannot exempt writes", () => {
  for (const body of [
    `await page.route("**/api/**", route => route.fulfill({ json: {} }), { times: 1 });
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("button", { name: "Save" }).click();`,
    `await page.route("**/api/**", route => route.fulfill({ json: {} }), options);
      await page.getByRole("button", { name: "Save" }).click();`,
    `await page.route("**/api/**", route => route.fulfill({ json: {} }));
      const otherPage = await context.newPage();
      await otherPage.getByRole("button", { name: "Save" }).click();`,
    `await page.route("**/api/**", route => route.fulfill({ json: {} }));
      await popup.getByRole("button", { name: "Save" }).click();`,
    `await page.route("**/api/**", route => route.fulfill({ json: {} }));
      await saveButton.click();`,
  ]) {
    assert.ok(checkLiveSuite(`${liveImports}
      test("write", async ({ page, context }) => { ${body} });`).some(issue => /guard/.test(issue)));
    assert.deepEqual(checkLiveSuite(`${liveImports}
      test("write", async ({ page, context }) => { requireAuditDevelopment(); ${body} });`), []);
  }
});

test("helper routing changes invalidate a caller's mock exemption", () => {
  for (const helper of [
    `async function removeMocks(page) { await page.unrouteAll(); }`,
    `async function removeMocks(page) { await reset(page); }
      async function reset(page) { await page.unroute("**/api/**"); }`,
    `const removeMocks = async page => page.unrouteAll();`,
  ]) {
    const body = `await page.route("**/api/**", route => route.fulfill({ json: {} }));
      await removeMocks(page);
      await page.getByRole("button", { name: "Save" }).click();`;
    assert.ok(checkLiveSuite(`${liveImports} ${helper}
      test("write", async ({ page }) => { ${body} });`).some(issue => /guard/.test(issue)));
    assert.deepEqual(checkLiveSuite(`${liveImports} ${helper}
      test("write", async ({ page }) => { requireAuditDevelopment(); ${body} });`), []);
  }
});

test("unresolved fetch method properties are potentially mutating", () => {
  for (const options of [
    `{ method }`,
    `{ ["method"]: "POST" }`,
    `{ [key]: verb }`,
    `{ get method() { return "POST"; } }`,
    `{ ...options }`,
  ]) {
    const body = `const method = "POST"; await fetch("/api/posts", ${options});`;
    assert.ok(checkLiveSuite(`${liveImports}
      test("write", async () => { ${body} });`).some(issue => /guard/.test(issue)));
    assert.deepEqual(checkLiveSuite(`${liveImports}
      test("write", async () => { requireAuditDevelopment(); ${body} });`), []);
  }
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
  assert.deepEqual(checkMaintenanceCommand(`import { progressLeftoversEnvironment } from "./member-progress-browser-environment";
    async function main() {
      progressLeftoversEnvironment();
      const { db } = await import("@workspace/db");
      await db.delete(activityTable);
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