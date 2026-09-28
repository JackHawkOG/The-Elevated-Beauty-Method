import { expect, test } from "vitest";
import { progressBrowserEnvironment } from "./member-progress-browser-environment";

const development = {
  NODE_ENV: "development",
  CLERK_SECRET_KEY: "sk_test_placeholder",
  CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
  VITE_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
  REPLIT_DEV_DOMAIN: "example.replit.dev",
  DATABASE_URL: "postgresql://member@dev-db:5432/memberdb",
  PGHOST: "dev-db",
  PGPORT: "5432",
  PGDATABASE: "memberdb",
  PGUSER: "member",
  CHROMIUM_PATH: process.execPath,
};

test("accepts only a matched development workspace target", () => {
  expect(progressBrowserEnvironment(development).base).toBe("https://example.replit.dev");
  expect(progressBrowserEnvironment({
    ...development, DATABASE_URL: `${development.DATABASE_URL}?sslmode=require`,
  }).base).toBe("https://example.replit.dev");
});

test("activity-only checks the development database without requiring Clerk or a browser", () => {
  const withoutClerk = {
    ...development,
    CLERK_SECRET_KEY: undefined,
    CLERK_PUBLISHABLE_KEY: undefined,
    VITE_CLERK_PUBLISHABLE_KEY: undefined,
    REPLIT_DEV_DOMAIN: undefined,
    CHROMIUM_PATH: "/missing/browser",
  };
  expect(() => progressBrowserEnvironment(withoutClerk, true)).not.toThrow();
  expect(() => progressBrowserEnvironment(withoutClerk)).toThrow(/development Clerk/);
  expect(() => progressBrowserEnvironment({ ...withoutClerk, NODE_ENV: "production" }, true))
    .toThrow(/development workspace/);
  expect(() => progressBrowserEnvironment({
    ...withoutClerk, DATABASE_URL: `${development.DATABASE_URL}?host=another-db`,
  }, true)).toThrow(/connection options/);
});

test.each([
  [{ NODE_ENV: "production" }, /development workspace/],
  [{ REPLIT_DEPLOYMENT: "1" }, /development workspace/],
  [{ CLERK_SECRET_KEY: "sk_live_placeholder" }, /development Clerk/],
  [{ CLERK_PUBLISHABLE_KEY: "pk_live_placeholder" }, /development Clerk/],
  [{ VITE_CLERK_PUBLISHABLE_KEY: "pk_test_different" }, /development Clerk/],
  [{ REPLIT_DEV_DOMAIN: "published.example.com" }, /development preview/],
  [{ DATABASE_URL: "postgresql://member@production-db/memberdb" }, /development PG\* target/],
  [{ DATABASE_URL: `${development.DATABASE_URL}?host=production-db` }, /connection options/],
  [{ DATABASE_URL: `${development.DATABASE_URL}?port=5434` }, /connection options/],
  [{ DATABASE_URL: `${development.DATABASE_URL}?database=production` }, /connection options/],
  [{ DATABASE_URL: `${development.DATABASE_URL}?hostaddr=192.0.2.1` }, /connection options/],
   [{ PGHOSTADDR: "192.0.2.1" }, /development PG\* target/],
   [{ PGSERVICE: "production" }, /development PG\* target/],
  [{ PGDATABASE: "other" }, /development PG\* target/],
  [{ DATABASE_URL: "not-a-url" }, /development DATABASE_URL/],
  [{ CHROMIUM_PATH: "/missing/progress-check-browser" }, /executable Chromium/],
])("rejects unsafe or unavailable browser-check prerequisites", (change, error) => {
  expect(() => progressBrowserEnvironment({ ...development, ...change })).toThrow(error);
});