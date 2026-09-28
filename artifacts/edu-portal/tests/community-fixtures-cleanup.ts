// From the workspace root: pnpm run cleanup:community-fixtures [--delete]
// Dry run by default. Only explicitly marked fixtures older than 24 hours qualify.
import { createClerkClient } from "@clerk/backend";
import { requireCommunityDevelopment } from "./community-fixtures";
import { cleanupCommunityFixtures } from "./community-fixtures-cleanup-core";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:community-fixtures [--delete]");
  }
  requireCommunityDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  // Do not open a database connection until the environment has been checked.
  const { db, pool } = await import("../../../lib/db/src/index");
  try {
    await cleanupCommunityFixtures({
      client: {
        getUserList: options => client.users.getUserList(options),
        getUser: id => client.users.getUser(id),
        deleteUser: id => client.users.deleteUser(id),
      },
      db, deleteRows: args.length > 0,
    });
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });