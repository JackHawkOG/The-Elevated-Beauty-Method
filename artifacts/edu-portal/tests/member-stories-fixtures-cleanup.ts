// From the workspace root: pnpm run cleanup:story-fixtures [--delete]
// Dry run by default. Unmarked identities and fixtures younger than 24 hours are never removed.
import { createClerkClient } from "@clerk/backend";
import { isStoryFixture, requireStoryDevelopment, staleStoryFixture } from "./member-stories-fixtures";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:story-fixtures [--delete]");
  }
  requireStoryDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const candidates: Array<{ id: string; email: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      if (staleStoryFixture(user)) candidates.push({ id: user.id, email: user.emailAddresses[0].emailAddress });
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }
  if (!candidates.length) {
    console.log("No stale marked story fixtures found. Older unmarked accounts require manual review.");
    return;
  }

  const [{ db, pool, memberStoriesTable, usersTable }, { eq, and, or }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
  try {
    for (const candidate of candidates) {
      requireStoryDevelopment();
      const user = await client.users.getUser(candidate.id);
      const fixture = staleStoryFixture(user);
      if (!fixture || user.emailAddresses[0].emailAddress !== candidate.email) {
        throw new Error(`Story fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      await db.transaction(async tx => {
        const members = await tx.select().from(usersTable).where(eq(usersTable.clerkId, user.id));
        if (members.some(member => member.email !== candidate.email || member.membershipTier !== "Free" ||
            member.displayName !== `Story ${fixture.role === "owner" ? "Owner" : "Member"}` ||
            member.bio !== null || member.avatarUrl !== null || member.skinType !== null ||
            member.undertone !== null || member.featureNeeds !== null || member.lifeStage !== null ||
            member.visibilityGoal !== null)) {
          throw new Error(`Non-fixture member record; refusing deletion for ${candidate.id}`);
        }
        const stories = await tx.select().from(memberStoriesTable).where(or(
          eq(memberStoriesTable.permissionRecordedBy, user.id),
          eq(memberStoriesTable.withdrawnBy, user.id),
          eq(memberStoriesTable.removalRequestedBy, user.id),
        ));
        if (stories.some(story => fixture.role !== "owner" || !isStoryFixture(story, fixture.tag, user.id))) {
          throw new Error(`Non-fixture story; refusing deletion for ${candidate.id}`);
        }
        console.log(`${args.length ? "Removing" : "Would remove"} ${candidate.id} (${candidate.email}): ${stories.length} stories, ${members.length} member rows`);
        if (!args.length) return;
        for (const story of stories) {
          await tx.delete(memberStoriesTable).where(and(
            eq(memberStoriesTable.id, story.id), eq(memberStoriesTable.permissionRecordedBy, user.id),
          ));
        }
        await tx.delete(usersTable).where(and(eq(usersTable.clerkId, user.id), eq(usersTable.email, candidate.email)));
      });
      // Keep the marked Clerk identity if database cleanup fails, so the next run can retry.
      if (args.length) await client.users.deleteUser(user.id);
    }
    if (!args.length) console.log("Dry run; nothing deleted. Pass --delete to remove these fixtures.");
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });