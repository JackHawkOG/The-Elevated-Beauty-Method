// From the workspace root: pnpm run cleanup:community-fixtures [--delete]
// Dry run by default. Only explicitly marked fixtures older than 24 hours qualify.
import { createClerkClient } from "@clerk/backend";
import {
  isCommunityFixtureActivity, isCommunityFixturePost, requireCommunityDevelopment,
  staleCommunityFixtureTag,
} from "./community-fixtures";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:community-fixtures [--delete]");
  }
  requireCommunityDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const candidates: Array<{ id: string; email: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      if (staleCommunityFixtureTag(user)) {
        candidates.push({ id: user.id, email: user.emailAddresses[0].emailAddress });
      }
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }
  if (!candidates.length) {
    console.log("No stale marked community fixtures found.");
    return;
  }
  // Do not open a database connection until the environment has been checked.
  const [{ db, pool, announcementsTable, activityTable, usersTable }, { eq, inArray, and }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    for (const candidate of candidates) {
      requireCommunityDevelopment();
      const user = await client.users.getUser(candidate.id);
      const tag = staleCommunityFixtureTag(user);
      if (!tag || user.emailAddresses[0].emailAddress !== candidate.email) {
        throw new Error(`Community fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      await db.transaction(async tx => {
        const members = await tx.select().from(usersTable).where(eq(usersTable.clerkId, user.id));
        if (members.some(member =>
          member.email !== candidate.email || member.membershipTier !== "Free" ||
          member.displayName !== "Community Check" || member.bio !== null ||
          member.avatarUrl !== null || member.skinType !== null || member.undertone !== null ||
          member.featureNeeds !== null || member.lifeStage !== null || member.visibilityGoal !== null
        )) throw new Error(`Non-fixture member record; refusing deletion for ${candidate.id}`);
        const posts = await tx.select().from(announcementsTable).where(eq(announcementsTable.actorId, user.id));
        if (posts.some(post => !isCommunityFixturePost(post, tag) ||
          !["Community Check", "Community Member"].includes(post.authorName))) {
          throw new Error(`Non-fixture announcement; refusing deletion for ${candidate.id}`);
        }
        const activities = posts.length
          ? await tx.select().from(activityTable).where(inArray(activityTable.sourceAnnouncementId, posts.map(post => post.id)))
          : [];
        if (activities.some(activity =>
          !isCommunityFixtureActivity(activity, posts.find(post => post.id === activity.sourceAnnouncementId)!))) {
          throw new Error(`Non-fixture activity; refusing deletion for ${candidate.id}`);
        }
        console.log(`${args.length ? "Removing" : "Would remove"} ${candidate.id}: ${posts.length} posts, ${activities.length} activity rows, ${members.length} member rows`);
        if (!args.length) return;
        if (activities.length) await tx.delete(activityTable).where(inArray(activityTable.id, activities.map(row => row.id)));
        if (posts.length) await tx.delete(announcementsTable).where(inArray(announcementsTable.id, posts.map(post => post.id)));
        await tx.delete(usersTable).where(and(eq(usersTable.clerkId, user.id), eq(usersTable.email, candidate.email)));
      });
      // Database first: if Clerk deletion fails, rerunning will still find the marked identity.
      if (args.length) await client.users.deleteUser(user.id);
    }
    if (!args.length) console.log("Dry run; nothing deleted. Pass --delete to remove these fixtures.");
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });