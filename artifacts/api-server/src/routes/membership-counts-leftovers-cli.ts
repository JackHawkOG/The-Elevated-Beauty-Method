// From the workspace root: pnpm run inspect:paid-total-leftovers [--delete <run-uuid> <same-run-uuid>]
// Only marked, aged development Clerk identities are eligible. Unmarked legacy accounts require manual review.
import { confirmedRun, fixtureIdentity, fixtureMember, requirePaidTotalDevelopment, unmarkedIdentity } from "./membership-counts-leftovers";

async function main() {
  const run = confirmedRun(process.argv.slice(2));
  requirePaidTotalDevelopment();
  const { clerkClient } = await import("@clerk/express");
  const { db, pool, usersTable, enrollmentsTable, lessonCompletionsTable, announcementsTable } = await import("@workspace/db");
  const { eq, and } = await import("drizzle-orm");
  try {
    const candidates: Array<{ id: string; run: string; role: string; email: string }> = [];
    const legacy: Array<{ id: string; run: string; role: string; email: string }> = [];
    for (let offset = 0; ; offset += 100) {
      const page = await clerkClient.users.getUserList({ limit: 100, offset });
      for (const user of page.data) {
        const fixture = fixtureIdentity(user);
        if (fixture) candidates.push({ id: user.id, ...fixture });
        else if (!run) {
          const possible = unmarkedIdentity(user);
          if (possible) legacy.push({ id: user.id, ...possible });
        }
      }
      if (!page.data.length || offset + page.data.length >= page.totalCount) break;
    }
    if (run && !candidates.some(candidate => candidate.run === run)) {
      throw new Error("No aged, marked paid-total identities found for that run");
    }
    for (const candidate of candidates.filter(candidate => !run || candidate.run === run)) {
      const members = await db.select().from(usersTable).where(eq(usersTable.clerkId, candidate.id));
      const enrollments = await db.select({ id: enrollmentsTable.id }).from(enrollmentsTable)
        .where(eq(enrollmentsTable.userId, candidate.id));
      const completions = await db.select({ id: lessonCompletionsTable.lessonId }).from(lessonCompletionsTable)
        .where(eq(lessonCompletionsTable.userId, candidate.id));
      const posts = await db.select({ id: announcementsTable.id }).from(announcementsTable)
        .where(eq(announcementsTable.actorId, candidate.id));
      const safe = members.every(member => fixtureMember(member, candidate.email)) &&
        !enrollments.length && !completions.length && !posts.length;
      console.log(JSON.stringify({
        run: candidate.run, role: candidate.role, clerkId: candidate.id, email: candidate.email,
        localMemberRows: members.length, enrollments: enrollments.length,
        completions: completions.length, posts: posts.length, eligible: safe,
      }));
      if (!run) continue;
      if (!safe) throw new Error(`Non-fixture local records found for ${candidate.id}; refusing deletion`);
      requirePaidTotalDevelopment();
      const current = await clerkClient.users.getUser(candidate.id);
      const verified = fixtureIdentity(current);
      if (!verified || verified.run !== run || verified.email !== candidate.email || verified.role !== candidate.role) {
        throw new Error(`Clerk identity changed for ${candidate.id}; refusing deletion`);
      }
      const removed = await db.transaction(async tx => {
        const rows = await tx.select().from(usersTable).where(eq(usersTable.clerkId, candidate.id));
        if (rows.some(member => !fixtureMember(member, candidate.email))) {
          throw new Error(`Member changed for ${candidate.id}; refusing deletion`);
        }
        const linked = await Promise.all([
          tx.select({ id: enrollmentsTable.id }).from(enrollmentsTable).where(eq(enrollmentsTable.userId, candidate.id)),
          tx.select({ id: lessonCompletionsTable.lessonId }).from(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, candidate.id)),
          tx.select({ id: announcementsTable.id }).from(announcementsTable).where(eq(announcementsTable.actorId, candidate.id)),
        ]);
        if (linked.some(rows => rows.length)) throw new Error(`Related records appeared for ${candidate.id}; refusing deletion`);
        return tx.delete(usersTable).where(and(eq(usersTable.clerkId, candidate.id), eq(usersTable.email, candidate.email)))
          .returning({ id: usersTable.id });
      });
      // Delete the database row first so a failed Clerk deletion remains discoverable on retry.
      await clerkClient.users.deleteUser(candidate.id);
      console.log(`Removed ${candidate.id}: 1 Clerk identity, ${removed.length} local member row(s)`);
    }
    if (!run) {
      for (const candidate of legacy) {
        const members = await db.select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable).where(eq(usersTable.clerkId, candidate.id));
        console.log(JSON.stringify({
          ...candidate, localMemberRows: members.length, localEmails: members.map(member => member.email),
          eligible: false, reason: "Unmarked older identity; requires manual ownership review",
        }));
      }
      console.log("Dry run only. To remove a marked run, pass --delete <run-uuid> <same-run-uuid>.");
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });