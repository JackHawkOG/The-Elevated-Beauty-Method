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
});

test.each([
  [{ NODE_ENV: "production" }, /development workspace/],
  [{ REPLIT_DEPLOYMENT: "1" }, /development workspace/],
  [{ CLERK_SECRET_KEY: "sk_live_placeholder" }, /development Clerk/],
  [{ CLERK_PUBLISHABLE_KEY: "pk_live_placeholder" }, /development Clerk/],
  [{ VITE_CLERK_PUBLISHABLE_KEY: "pk_test_different" }, /development Clerk/],
  [{ REPLIT_DEV_DOMAIN: "published.example.com" }, /development preview/],
  [{ DATABASE_URL: "postgresql://member@production-db/memberdb" }, /development PG\* target/],
  [{ PGDATABASE: "other" }, /development PG\* target/],
  [{ DATABASE_URL: "not-a-url" }, /development DATABASE_URL/],
  [{ CHROMIUM_PATH: "/missing/progress-check-browser" }, /executable Chromium/],
])("rejects unsafe or unavailable browser-check prerequisites", (change, error) => {
  expect(() => progressBrowserEnvironment({ ...development, ...change })).toThrow(error);
});