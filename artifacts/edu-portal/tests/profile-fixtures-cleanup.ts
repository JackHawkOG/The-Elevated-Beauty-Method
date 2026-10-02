// From the workspace root: pnpm run cleanup:profile-fixtures [--delete]
// Dry run by default; older unmarked accounts are never eligible for automated deletion.
import { createClerkClient } from "@clerk/backend";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import {
  possibleUnmarkedProfileFixture, profileFixtureMember, staleProfileFixture,
} from "./profile-fixtures";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--delete")) {
    throw new Error("Usage: pnpm run cleanup:profile-fixtures [--delete]");
  }
  requireAuditDevelopment();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const candidates: Array<{ id: string; email: string; role: "a" | "b"; tag: string }> = [];
  const legacy: Array<{ id: string; email: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      const fixture = staleProfileFixture(user);
      if (fixture) candidates.push({ id: user.id, ...fixture });
      else if (!args.length) {
        const possible = possibleUnmarkedProfileFixture(user);
        if (possible) legacy.push({ id: user.id, email: possible.email });
      }
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }
  if (!candidates.length && !legacy.length) {
    console.log("No stale marked profile fixtures found. Older unmarked accounts require manual review.");
    return;
  }
  const [{
    db, pool, usersTable, enrollmentsTable, lessonCompletionsTable,
    announcementsTable, memberStoriesTable, radiantAuditsTable, radiantAuditDraftsTable,
    radiantAuditHistoryTable, radiantAuditSubmissionsTable,
    activityTable, announcementActivityCorrectionsTable, memberStoryReviewCorrectionsTable,
  }, { eq, and, or, sql, getTableColumns }] = await Promise.all([
    import("../../../lib/db/src/index"), import("drizzle-orm"),
  ]);
  try {
    for (const candidate of candidates) {
      requireAuditDevelopment();
      const user = await client.users.getUser(candidate.id);
      const fixture = staleProfileFixture(user);
      if (!fixture || fixture.email !== candidate.email ||
          fixture.tag !== candidate.tag || fixture.role !== candidate.role) {
        throw new Error(`Profile fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      await db.transaction(async tx => {
        const members = await tx.select({
          ...getTableColumns(usersTable),
          // Capture the exact database representation, including timestamp precision.
          cleanupSnapshot: sql<string>`to_jsonb(${usersTable})::text`,
        }).from(usersTable).where(eq(usersTable.clerkId, candidate.id));
        if (members.some(member => !profileFixtureMember(member, fixture))) {
          throw new Error(`Non-fixture member row; refusing deletion for ${candidate.id}`);
        }
        const linked = await Promise.all([
          tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(eq(enrollmentsTable.userId, candidate.id)),
          tx.select({ id: lessonCompletionsTable.lessonId }).from(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, candidate.id)),
          tx.select({ id: announcementsTable.id }).from(announcementsTable).where(eq(announcementsTable.actorId, candidate.id)),
          tx.select({ id: memberStoriesTable.id }).from(memberStoriesTable).where(or(
            eq(memberStoriesTable.permissionRecordedBy, candidate.id),
            eq(memberStoriesTable.withdrawnBy, candidate.id),
            eq(memberStoriesTable.removalRequestedBy, candidate.id),
            eq(memberStoriesTable.verifiedSubjectUserId, candidate.id),
            eq(memberStoriesTable.subjectVerifiedBy, candidate.id),
            eq(memberStoriesTable.removalReviewedBy, candidate.id),
          )),
          tx.select({ id: activityTable.id }).from(activityTable).where(eq(activityTable.sourceReviewedBy, candidate.id)),
          tx.select({ id: announcementActivityCorrectionsTable.id }).from(announcementActivityCorrectionsTable).where(or(
            eq(announcementActivityCorrectionsTable.previousReviewedBy, candidate.id),
            eq(announcementActivityCorrectionsTable.correctedBy, candidate.id),
          )),
          tx.select({ id: memberStoryReviewCorrectionsTable.id }).from(memberStoryReviewCorrectionsTable)
            .where(eq(memberStoryReviewCorrectionsTable.reviewedBy, candidate.id)),
          tx.execute(sql`SELECT id FROM membership_checkouts WHERE clerk_id = ${candidate.id}`)
            .then(result => result.rows),
          tx.select().from(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, candidate.id)),
          tx.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, candidate.id)),
          tx.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, candidate.id)),
          tx.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, candidate.id)),
        ]);
        if (linked.some(rows => rows.length)) {
          throw new Error(`Related member data exists; refusing deletion for ${candidate.id}`);
        }
        console.log(`${args.length ? "Removing" : "Would remove"} ${candidate.id} (${candidate.email}): ${members.length} member row(s)`);
        if (args.length && members.length) {
          const deleted = await tx.delete(usersTable).where(and(
            eq(usersTable.clerkId, candidate.id), eq(usersTable.email, candidate.email),
            or(...members.map(member => and(
              eq(usersTable.id, member.id),
              sql`to_jsonb(${usersTable}) = ${member.cleanupSnapshot}::jsonb`,
            ))),
          )).returning({ id: usersTable.id });
          if (deleted.length !== members.length) {
            throw new Error(`Profile fixture member changed during cleanup; refusing deletion for ${candidate.id}`);
          }
        }
      });
      // Keep the marked Clerk identity on DB failure so a rerun can finish.
      if (args.length) await client.users.deleteUser(candidate.id);
    }
    if (!args.length) {
      for (const possible of legacy) {
        const members = await db.select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable).where(eq(usersTable.clerkId, possible.id));
        console.log(JSON.stringify({
          clerkId: possible.id, email: possible.email,
          localMemberRows: members.length, localEmails: members.map(member => member.email),
          eligible: false, reason: "Unmarked older identity; ownership requires manual review",
        }));
      }
    }
    if (!args.length) console.log("Dry run; nothing deleted. Pass --delete to remove marked, aged fixtures.");
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });