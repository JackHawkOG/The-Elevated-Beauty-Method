// From the workspace root: pnpm run cleanup:profile-fixtures [--delete]
// Dry run by default; unmarked accounts require an explicit independently owned recovery scope.
// After reviewing the interrupted run's private ownership and exact account IDs:
// pnpm run cleanup:profile-fixtures --recover-run RUN_UUID --id user_ID [--id user_ID ...]
// Add --delete only after the dry run; never substitute an email match for run ownership.
import { createClerkClient } from "@clerk/backend";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import {
  possibleUnmarkedProfileFixture, profileFixtureMember, staleProfileFixture, recoverableProfileFixture,
} from "./profile-fixtures";
import { profileCleanupArguments } from "./profile-fixtures-recovery";

async function main() {
  requireAuditDevelopment();
  const { deleteRows, recovery } = profileCleanupArguments(process.argv.slice(2));
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const eligible = (user: Parameters<typeof staleProfileFixture>[0]) =>
    recovery ? recoverableProfileFixture(user, recovery.run) : staleProfileFixture(user);
  const candidates: Array<{ id: string; email: string; role: "a" | "b"; tag: string }> = [];
  const legacy: Array<{ id: string; email: string }> = [];
  if (recovery) {
    // Review every requested identity before any database write. An explicit
    // not-found is safe on retry; network/auth failures are not absence.
    for (const id of recovery.ids) {
      requireAuditDevelopment();
      let user;
      try { user = await client.users.getUser(id); }
      catch (error) {
        if ((error as { status?: number }).status === 404) continue;
        throw error;
      }
      const fixture = eligible(user);
      if (user.id !== id || !fixture) {
        throw new Error(`Recovery ownership or aged fixture shape refused for ${id}`);
      }
      candidates.push({ id, ...fixture });
    }
  } else for (let offset = 0; ; offset += 100) {
    const page = await client.users.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      const fixture = staleProfileFixture(user);
      if (fixture) candidates.push({ id: user.id, ...fixture });
      else if (!deleteRows) {
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
      const fixture = eligible(user);
      if (user.id !== candidate.id || !fixture || fixture.email !== candidate.email ||
          fixture.tag !== candidate.tag || fixture.role !== candidate.role) {
        throw new Error(`Profile fixture identity changed; refusing deletion for ${candidate.id}`);
      }
      const relatedData = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
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
        return linked.some(rows => rows.length);
      };
      const removedMembers = await db.transaction(async tx => {
        const members = await tx.select({
          ...getTableColumns(usersTable),
          // Capture the exact database representation, including timestamp precision.
          cleanupSnapshot: sql<string>`to_jsonb(${usersTable})::text`,
        }).from(usersTable).where(eq(usersTable.clerkId, candidate.id));
        if (members.some(member => !profileFixtureMember(member, fixture))) {
          throw new Error(`Non-fixture member row; refusing deletion for ${candidate.id}`);
        }
        if (await relatedData(tx)) {
          throw new Error(`Related member data exists; refusing deletion for ${candidate.id}`);
        }
        console.log(`${deleteRows ? "Removing" : "Would remove"} ${candidate.id} (${candidate.email}): ${members.length} member row(s)`);
        if (deleteRows && members.length) {
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
        return members;
      });
      // Keep the marked Clerk identity on DB failure so a rerun can finish.
      if (deleteRows) {
        const restore = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
          // Never overwrite a newly recreated member. JSON preserves precision.
          for (const member of removedMembers) {
            await tx.execute(sql`INSERT INTO ${usersTable}
              SELECT * FROM json_populate_record(NULL::users, ${member.cleanupSnapshot}::json)
              ON CONFLICT DO NOTHING`);
          }
        };
        let externalDeletionStarted = false;
        let refusal: string | undefined;
        try {
          refusal = await db.transaction(async tx => {
            // Development cleanup only: fence ALL guarded tables, including tables
            // without user foreign keys. A fresh READ COMMITTED snapshot after the
            // locks sees writes committed since the first transaction. Keep the
            // fence through the external call, not just through its guard queries.
            await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
            await tx.execute(sql`LOCK TABLE
              users, enrollments, lesson_completions, announcements, member_stories,
              activity, announcement_activity_corrections, member_story_review_corrections,
              membership_checkouts, radiant_audit_drafts, radiant_audits,
              radiant_audit_history, radiant_audit_submissions IN SHARE ROW EXCLUSIVE MODE`);
            const currentMembers = await tx.select().from(usersTable).where(eq(usersTable.clerkId, candidate.id));
            const linked = await relatedData(tx);
            const refusal = `Profile fixture data or identity changed after database cleanup; refusing deletion for ${candidate.id}`;
            if (currentMembers.length || linked) {
              // Known DB refusal must not depend on Clerk being available.
              await restore(tx);
              return refusal;
            }
            const currentUser = await client.users.getUser(candidate.id);
            const currentFixture = eligible(currentUser);
            const identityChanged = currentUser.id !== candidate.id || !currentFixture || currentFixture.email !== candidate.email ||
              currentFixture.tag !== candidate.tag || currentFixture.role !== candidate.role;
            if (identityChanged) {
              await restore(tx);
              return refusal;
            }
            requireAuditDevelopment();
            externalDeletionStarted = true;
            await client.users.deleteUser(candidate.id);
            return undefined;
          });
        } catch (error) {
          if (!externalDeletionStarted) {
            // The failed fence transaction has rolled back, releasing partial
            // locks. Restore independently of Clerk and the linked tables.
            // Do not reuse its lock timeout: a concurrent user writer may need
            // to finish before the conflict-safe INSERT can complete.
            try { await db.transaction(restore); }
            catch (restorationError) {
              throw new AggregateError([error, restorationError],
                `Profile cleanup stopped before Clerk deletion but profile restoration failed for ${candidate.id}`);
            }
          }
          // After an uncertain deleteUser result, retain DB-first retry behavior;
          // restoring then could recreate a profile for a deleted identity.
          throw error;
        }
        if (refusal) throw new Error(refusal);
      }
    }
    if (!deleteRows) {
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
    if (!deleteRows) console.log("Dry run; nothing deleted. Pass --delete to remove eligible, aged fixtures.");
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });