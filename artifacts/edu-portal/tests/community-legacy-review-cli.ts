// From the workspace root: pnpm run inspect:community-legacy
// Read-only leads for human review. An email match is NOT proof of fixture ownership.
import { createClerkClient } from "@clerk/backend";
import { possibleLegacyCommunityIdentity, requireCommunityDevelopment } from "./community-fixtures";

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: pnpm run inspect:community-legacy (no deletion options)");
  }
  requireCommunityDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const candidates: Array<{ id: string; matchedEmail: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      const matchedEmail = possibleLegacyCommunityIdentity(user);
      if (matchedEmail) candidates.push({ id: user.id, matchedEmail });
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }

  // No database connection until the development guard has passed.
  const [{ db, pool, announcementsTable, activityTable, usersTable }, { eq, inArray }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    const report = [];
    for (const candidate of candidates) {
      requireCommunityDevelopment();
      const identity = await client.users.getUser(candidate.id);
      if (possibleLegacyCommunityIdentity(identity) !== candidate.matchedEmail) {
        throw new Error(`Identity changed during review: ${candidate.id}; rerun the report.`);
      }
      const members = await db.select().from(usersTable).where(eq(usersTable.clerkId, identity.id));
      const announcements = await db.select().from(announcementsTable)
        .where(eq(announcementsTable.actorId, identity.id));
      const activities = announcements.length
        ? await db.select().from(activityTable)
          .where(inArray(activityTable.sourceAnnouncementId, announcements.map(post => post.id)))
        : [];
      report.push({
        clerkId: identity.id,
        matchedEmail: candidate.matchedEmail,
        allEmails: identity.emailAddresses.map(address => address.emailAddress),
        name: [identity.firstName, identity.lastName].filter(Boolean).join(" "),
        createdAt: new Date(identity.createdAt).toISOString(),
        hasOtherPrivateMetadata: Object.keys(identity.privateMetadata).length > 0,
        members,
        announcements: announcements.map(post => ({
          ...post,
          activity: activities.filter(row => row.sourceAnnouncementId === post.id),
        })),
        // Name/title matches without a sourceAnnouncementId are deliberately
        // not attributed to this identity; there is no reliable relationship.
      });
    }
    console.log(JSON.stringify({
      warning: "Review leads only. No ownership is established by this report; no rows or accounts were deleted. Independently confirm ownership and every linked row before any manual removal. The marked-fixture cleanup cannot remove these unmarked identities.",
      candidates: report,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });