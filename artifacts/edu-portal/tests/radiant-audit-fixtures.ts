import type { User } from "@clerk/backend";

const fixtureMarker = "radiant-audit-live-v1";
const fixtureEmail = /^audit-fixture-(?:a|b|late-a|late-b|wrong|staged|signup|signin|delete-failure)-[0-9a-f]{12}\+clerk_test@example\.com$/;
const minimumAgeMs = 24 * 60 * 60 * 1000;

export function requireAuditDevelopment(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" || env.REPLIT_DEPLOYMENT) {
    throw new Error("Audit fixtures can only be managed in development.");
  }
  if (!env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error("Audit fixtures require development Clerk keys.");
  }
  if (!env.REPLIT_DEV_DOMAIN?.endsWith(".replit.dev") ||
      !env.DATABASE_URL || !env.PGHOST || !env.PGDATABASE || !env.PGUSER || !env.PGPORT ||
      env.PGHOSTADDR || env.PGSERVICE) {
    throw new Error("Audit fixtures require the workspace development preview and database.");
  }
  const target = new URL(env.DATABASE_URL);
  const connectionOptions = new Set([
    "sslmode", "sslcert", "sslkey", "sslrootcert", "application_name",
    "connect_timeout", "keepalives", "keepalives_idle", "keepalives_interval",
    "keepalives_count",
  ]);
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      target.hostname !== env.PGHOST ||
      decodeURIComponent(target.pathname.slice(1)) !== env.PGDATABASE ||
      decodeURIComponent(target.username) !== env.PGUSER ||
      (target.port || "5432") !== env.PGPORT ||
       [...target.searchParams.keys()].some(key => !connectionOptions.has(key.toLowerCase()))) {
    throw new Error("DATABASE_URL does not match the workspace development database.");
  }
}

export function auditFixtureEmail(role: "a" | "b" | "late-a" | "late-b" | "wrong" | "staged" | "signup" | "signin" | "delete-failure", tag: string) {
  return `audit-fixture-${role}-${tag}+clerk_test@example.com`;
}

export const auditFixturePrivateMetadata = { auditLiveFixture: fixtureMarker };

export function isStaleAuditFixture(user: Pick<User, "emailAddresses" | "privateMetadata" | "createdAt">, now = Date.now()) {
  return user.privateMetadata.auditLiveFixture === fixtureMarker &&
    user.emailAddresses.length === 1 &&
    fixtureEmail.test(user.emailAddresses[0].emailAddress) &&
    Number.isFinite(user.createdAt) &&
    user.createdAt <= now - minimumAgeMs;
}