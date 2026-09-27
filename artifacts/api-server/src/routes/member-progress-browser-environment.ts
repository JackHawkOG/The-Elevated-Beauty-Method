import { accessSync, constants } from "node:fs";

// Keep this guard independent of the DB and Clerk clients: no side effects
// should run until the target environment has been checked.
export function progressBrowserEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" || env.REPLIT_DEPLOYMENT) {
    throw new Error("Progress browser check must run in a development workspace, not a deployment");
  }
  if (!env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      !env.VITE_CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      env.CLERK_PUBLISHABLE_KEY !== env.VITE_CLERK_PUBLISHABLE_KEY) {
    throw new Error("Progress browser check requires matching development Clerk server and web keys");
  }
  if (!env.REPLIT_DEV_DOMAIN || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.replit\.dev$/.test(env.REPLIT_DEV_DOMAIN)) {
    throw new Error("Progress browser check requires a REPLIT_DEV_DOMAIN development preview");
  }
  let target: URL;
  try {
    target = new URL(env.DATABASE_URL || "");
  } catch {
    throw new Error("Progress browser check requires the workspace development DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !env.PGHOST || !env.PGPORT || !env.PGDATABASE || !env.PGUSER ||
      target.hostname !== env.PGHOST ||
      (target.port || "5432") !== env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== env.PGDATABASE ||
      decodeURIComponent(target.username) !== env.PGUSER) {
    throw new Error("Progress browser check requires DATABASE_URL to match the workspace development PG* target");
  }
  // pg-connection-string applies URL query parameters after URL components.
  // In particular ?host= or ?port= can silently redirect a matching URL.
  // Permit connection-only options, never alternative targets or unknown keys.
  const connectionOptions = new Set([
    "sslmode", "sslcert", "sslkey", "sslrootcert", "application_name",
    "connect_timeout", "keepalives", "keepalives_idle", "keepalives_interval",
    "keepalives_count",
  ]);
  if ([...target.searchParams.keys()].some(key => !connectionOptions.has(key))) {
    throw new Error("Progress browser check rejects DATABASE_URL target-changing or unknown connection options");
  }
  const chromiumPath = env.CHROMIUM_PATH || "/repl/tools/bin/chromium";
  try {
    accessSync(chromiumPath, constants.X_OK);
  } catch {
    throw new Error(`Progress browser check requires an executable Chromium at ${chromiumPath}`);
  }
  return { base: `https://${env.REPLIT_DEV_DOMAIN}`, chromiumPath };
}