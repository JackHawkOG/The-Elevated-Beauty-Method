// From the workspace root: pnpm run cleanup:audit-fixtures [--delete]
// Without --delete, report only. Only marked, 24-hour-old development fixtures qualify.
import { createClerkClient } from "@clerk/backend";
import { auditFixturePrivateMetadata, isStaleAuditFixture, requireAuditDevelopment } from "./radiant-audit-fixtures";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:audit-fixtures [--delete]");
  }
  requireAuditDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const cutoff = Date.now();
  const candidates: Array<{ id: string; email: string; createdAt: number }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      if (isStaleAuditFixture(user, cutoff)) {
        candidates.push({ id: user.id, email: user.emailAddresses[0].emailAddress, createdAt: user.createdAt });
      }
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }
  if (!args.length) {
    console.log(JSON.stringify(candidates, null, 2));
    console.log(`${candidates.length} stale Audit fixture(s); dry run, nothing deleted.`);
    return;
  }
  // Dynamic import prevents opening a database connection before the guard succeeds.
  const [{ db, pool, radiantAuditsTable, radiantAuditDraftsTable, radiantAuditHistoryTable, radiantAuditSubmissionsTable, usersTable }, { eq, and }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    for (const candidate of candidates) {
      requireAuditDevelopment();
      const user = await client.users.getUser(candidate.id);
      if (!isStaleAuditFixture(user) || user.emailAddresses[0].emailAddress !== candidate.email ||
          user.privateMetadata.auditLiveFixture !== auditFixturePrivateMetadata.auditLiveFixture) {
        throw new Error(`Fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      await db.transaction(async tx => {
        const members = await tx.select().from(usersTable).where(eq(usersTable.clerkId, user.id));
        if (members.some(member => member.email !== candidate.email || member.membershipTier !== "Free")) {
          throw new Error(`Non-fixture member record; refusing deletion for ${candidate.id}`);
        }
        await tx.delete(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, user.id));
        await tx.delete(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, user.id));
        await tx.delete(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, user.id));
        await tx.delete(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, user.id));
        // Other FK references deliberately abort the transaction instead of deleting other member data.
        await tx.delete(usersTable).where(and(eq(usersTable.clerkId, user.id), eq(usersTable.email, candidate.email)));
      });
      // DB first, Clerk second: a failed Clerk request can be retried without losing the DB rows.
      await client.users.deleteUser(user.id);
      console.log(`Removed stale Audit fixture ${candidate.id}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });