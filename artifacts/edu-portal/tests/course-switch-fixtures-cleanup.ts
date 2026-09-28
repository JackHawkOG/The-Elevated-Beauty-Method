// From the workspace root: pnpm run cleanup:course-switch-fixtures [--delete]
// Default is a dry run; only explicitly marked fixtures older than 24 hours qualify.
import { createClerkClient } from "@clerk/backend";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import { cleanupCourseSwitchFixtures } from "./course-switch-fixtures-cleanup-core";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:course-switch-fixtures [--delete]");
  }
  requireAuditDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  // The DB module must not be loaded until the production guard has passed.
  const { db, pool } = await import("../../../lib/db/src/index");
  try {
    await cleanupCourseSwitchFixtures({ client: client.users, db, deleteRows: args.length === 1 });
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });