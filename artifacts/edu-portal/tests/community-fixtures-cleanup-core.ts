import type { User } from "@clerk/backend";
import { and, eq, inArray } from "drizzle-orm";
import type { db as database } from "../../../lib/db/src/index";
import { activityTable, announcementsTable, usersTable } from "../../../lib/db/src/schema";
import {
  isCommunityFixtureActivity, isCommunityFixturePost, requireCommunityDevelopment,
  staleCommunityFixtureTag,
} from "./community-fixtures";

type FixtureIdentity = Pick<User, "id" | "emailAddresses" | "privateMetadata" | "createdAt" | "firstName" | "lastName">;
type FixtureClient = {
  getUserList(options: { limit: number; offset: number }): Promise<{ data: FixtureIdentity[]; totalCount: number }>;
  getUser(id: string): Promise<FixtureIdentity>;
  deleteUser(id: string): Promise<unknown>;
};

export async function cleanupCommunityFixtures({
  client, db, deleteRows, env = process.env,
}: {
  client: FixtureClient;
  db: typeof database;
  deleteRows: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  requireCommunityDevelopment(env);
  const candidates: Array<{ id: string; email: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.getUserList({ limit: 100, offset });
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
  for (const candidate of candidates) {
    requireCommunityDevelopment(env);
    const user = await client.getUser(candidate.id);
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
      console.log(`${deleteRows ? "Removing" : "Would remove"} ${candidate.id}: ${posts.length} posts, ${activities.length} activity rows, ${members.length} member rows`);
      if (!deleteRows) return;
      if (activities.length) await tx.delete(activityTable).where(inArray(activityTable.id, activities.map(row => row.id)));
      if (posts.length) await tx.delete(announcementsTable).where(inArray(announcementsTable.id, posts.map(post => post.id)));
      await tx.delete(usersTable).where(and(eq(usersTable.clerkId, user.id), eq(usersTable.email, candidate.email)));
    });
    // Database first: if Clerk deletion fails, rerunning will still find the marked identity.
    if (deleteRows) await client.deleteUser(user.id);
  }
  if (!deleteRows) console.log("Dry run; nothing deleted. Pass --delete to remove these fixtures.");
}