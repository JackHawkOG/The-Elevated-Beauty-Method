import { expect, test } from "vitest";
import { requireDevelopmentDatabase } from "./test-development-database";

const development = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://member@dev-db:5432/memberdb",
  PGHOST: "dev-db",
  PGPORT: "5432",
  PGDATABASE: "memberdb",
  PGUSER: "member",
};

test("accepts the workspace development database target", () => {
  expect(() => requireDevelopmentDatabase(development)).not.toThrow();
  expect(() => requireDevelopmentDatabase({
    ...development,
    DATABASE_URL: `${development.DATABASE_URL}?sslmode=require`,
  })).not.toThrow();
});

test.each([
  [{ NODE_ENV: "production" }, /development workspace/],
  [{ REPLIT_DEPLOYMENT: "1" }, /development workspace/],
  [{ DATABASE_URL: undefined }, /development DATABASE_URL/],
  [{ DATABASE_URL: "not-a-url" }, /development DATABASE_URL/],
  [{ DATABASE_URL: "postgresql://member@production-db:5432/memberdb" }, /development PG\* target/],
  [{ DATABASE_URL: "postgresql://member@dev-db:5555/memberdb" }, /development PG\* target/],
  [{ DATABASE_URL: "postgresql://member@dev-db:5432/other" }, /development PG\* target/],
  [{ DATABASE_URL: "postgresql://other@dev-db:5432/memberdb" }, /development PG\* target/],
  [{ DATABASE_URL: "postgresql://member@dev-db:5432/memberdb?host=production-db" }, /development PG\* target/],
  [{ PGHOST: undefined }, /development PG\* target/],
])("rejects unsafe database configuration before fixtures start", (change, error) => {
  expect(() => requireDevelopmentDatabase({ ...development, ...change })).toThrow(error);
});