import { afterEach, expect, test, vi } from "vitest";
import { inspectProgressLeftovers, runProgressLeftovers } from "./member-progress-leftovers-cli";

const databaseImport = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => {
  databaseImport();
  throw new Error("Database import reached");
});

const development = {
  NODE_ENV: "development",
  REPLIT_DEPLOYMENT: undefined,
  DATABASE_URL: "postgresql://member@dev-db:5432/memberdb",
  PGHOST: "dev-db",
  PGPORT: "5432",
  PGDATABASE: "memberdb",
  PGUSER: "member",
  PGHOSTADDR: undefined,
  PGSERVICE: undefined,
};
const run = "12345678-1234-1234-1234-123456789abc";

function setEnvironment(change: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries({ ...development, ...change })) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test.each([
  [{ NODE_ENV: "production" }, /development workspace/],
  [{ REPLIT_DEPLOYMENT: "1" }, /development workspace/],
  [{ DATABASE_URL: "postgresql://member@production-db:5432/memberdb" }, /development PG\* target/],
  [{ DATABASE_URL: `${development.DATABASE_URL}?host=production-db` }, /connection options/],
  [{ DATABASE_URL: "not-a-url" }, /development DATABASE_URL/],
  [{ PGHOSTADDR: "192.0.2.1" }, /development PG\* target/],
  [{ PGSERVICE: "production" }, /development PG\* target/],
])("direct inspection rejects unsafe targets before importing the database", async (change, error) => {
  setEnvironment(change);
  const deleteIdentity = vi.fn();
  const log = vi.fn();
  const beforeDelete = vi.fn();
  for (const mode of ["full", "activity-only"] as const) {
    for (const selectedRun of [undefined, run]) {
      await expect(inspectProgressLeftovers(
        selectedRun, [], deleteIdentity, log, beforeDelete, mode,
      )).rejects.toThrow(error);
    }
  }
  expect(databaseImport).not.toHaveBeenCalled();
  expect(deleteIdentity).not.toHaveBeenCalled();
  expect(beforeDelete).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test("an injected safe environment cannot authorize the actual unsafe database target", async () => {
  setEnvironment({ DATABASE_URL: "postgresql://member@production-db:5432/memberdb" });
  const loadClerk = vi.fn();
  const log = vi.fn();
  await expect(runProgressLeftovers(
    ["--activity-only", "--delete", run, run], loadClerk, log, development,
  )).rejects.toThrow(/development PG\* target/);
  expect(databaseImport).not.toHaveBeenCalled();
  expect(loadClerk).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test("a verified development target reaches the database boundary without Clerk or Chromium", async () => {
  setEnvironment({});
  vi.stubEnv("CHROMIUM_PATH", "/missing/browser");
  await expect(inspectProgressLeftovers(
    undefined, [], vi.fn(), vi.fn(), undefined, "activity-only",
  )).rejects.toMatchObject({
    cause: expect.objectContaining({ message: "Database import reached" }),
  });
  expect(databaseImport).toHaveBeenCalledOnce();
});