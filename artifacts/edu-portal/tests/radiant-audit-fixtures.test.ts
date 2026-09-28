import { describe, expect, it } from "vitest";
import { auditFixtureEmail, auditFixturePrivateMetadata, isStaleAuditFixture, requireAuditDevelopment } from "./radiant-audit-fixtures";

const env = {
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev",
  PGHOST: "development.db",
  PGPORT: "5432",
  PGDATABASE: "development",
  PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};
const now = Date.now();
const identity = {
  emailAddresses: [{ emailAddress: auditFixtureEmail("a", "abcdef123456") }],
  privateMetadata: auditFixturePrivateMetadata,
  createdAt: now - 25 * 60 * 60 * 1000,
};

describe("Audit fixture cleanup boundaries", () => {
  it("requires an old, exactly marked fixture with its dedicated email shape", () => {
    expect(isStaleAuditFixture(identity, now)).toBe(true);
    expect(isStaleAuditFixture({ ...identity, createdAt: now - 23 * 60 * 60 * 1000 }, now)).toBe(false);
    expect(isStaleAuditFixture({ ...identity, privateMetadata: {} }, now)).toBe(false);
    expect(isStaleAuditFixture({ ...identity, emailAddresses: [{ emailAddress: "member@example.com" }] }, now)).toBe(false);
    expect(isStaleAuditFixture({ ...identity, emailAddresses: [{ emailAddress: "audit-a-abcdef123456+clerk_test@example.com" }] }, now)).toBe(false);
    expect(isStaleAuditFixture({ ...identity, emailAddresses: [...identity.emailAddresses, { emailAddress: "member@example.com" }] }, now)).toBe(false);
  });

  it("refuses deployment, live Clerk keys, and another database target", () => {
    expect(() => requireAuditDevelopment(env)).not.toThrow();
    expect(() => requireAuditDevelopment({ ...env, NODE_ENV: "production" })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, REPLIT_DEPLOYMENT: "1" })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, DATABASE_URL: "postgresql://dev@production.db/development" })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, DATABASE_URL: "postgresql://dev@development.db/production" })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&host=production.db` })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&options=-c%20search_path%3Dpublic` })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&unknown=override` })).toThrow();
    expect(() => requireAuditDevelopment({ ...env, PGHOSTADDR: "127.0.0.1" })).toThrow();
  });
});