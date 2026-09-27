// Validate before any test setup or cleanup can write to the database.
export function requireDevelopmentDatabase(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" || env.REPLIT_DEPLOYMENT) {
    throw new Error("Integration tests must run in a development workspace, not a deployment");
  }

  let target: URL;
  try {
    target = new URL(env.DATABASE_URL || "");
  } catch {
    throw new Error("Integration tests require the workspace development DATABASE_URL");
  }

  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !env.PGHOST || !env.PGPORT || !env.PGDATABASE || !env.PGUSER ||
      target.hostname !== env.PGHOST ||
      (target.port || "5432") !== env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== env.PGDATABASE ||
      decodeURIComponent(target.username) !== env.PGUSER ||
      // The pg parser accepts query parameters that override URL host/port/user.
      // Allow connection options such as sslmode, but never target overrides.
      [...target.searchParams.keys()].some(key => ["host", "hostaddr", "port", "user", "db", "database"].includes(key.toLowerCase()))) {
    throw new Error("Integration tests require DATABASE_URL to match the workspace development PG* target");
  }
}