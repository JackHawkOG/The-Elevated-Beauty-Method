// Run from the workspace root with pnpm run inspect:progress-leftovers.
// Import the clients only after validating the development environment.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { progressBrowserEnvironment } from "./member-progress-browser-environment";
import {
  activityRun, categoryRun, confirmedRun, eligibleRun, identityRun, staleCandidates, type Candidate,
} from "./member-progress-leftovers";

type Identity = { id: string; email: string; name: string; createdAt: Date };

// The same SQL path is used by the CLI and the guarded development DB test.
export async function inspectProgressLeftovers(
  run: string | undefined,
  identities: Identity[],
  deleteIdentity: (id: string) => Promise<unknown>,
  log: (message: string) => void = console.log,
) {
  const { and, eq, like, lte } = await import("drizzle-orm");
  const {
    db, categoriesTable, coursesTable, lessonsTable, usersTable,
    enrollmentsTable, lessonCompletionsTable, activityTable,
  } = await import("@workspace/db");
    const now = new Date();
    const categories = await db.select().from(categoriesTable);
    const members = await db.select().from(usersTable);
    const activities = await db.select().from(activityTable)
      .where(like(activityTable.actorName, "Progress Elevated %"));
    const candidates: Candidate[] = [
      ...categories.flatMap(category => {
        const id = categoryRun(category.slug, category.name);
        return id ? [{ kind: "category" as const, id: String(category.id), run: id,
          createdAt: category.createdAt, marker: category.slug, name: category.name }] : [];
      }),
      ...members.flatMap(member => {
        const id = identityRun(member.email, member.displayName);
        return id ? [{ kind: "member" as const, id: member.clerkId, run: id,
          createdAt: member.createdAt, marker: member.email, name: member.displayName }] : [];
      }),
      ...identities.flatMap(identity => {
        const id = identityRun(identity.email, identity.name);
        return id ? [{ kind: "clerk" as const, id: identity.id, run: id,
          createdAt: identity.createdAt, marker: identity.email, name: identity.name }] : [];
      }),
      ...activities.flatMap(activity => {
        const id = activityRun(activity.actorName, activity.entityTitle, activity.type, activity.description);
        return id ? [{ kind: "activity" as const, id: String(activity.id), run: id,
          createdAt: activity.createdAt, marker: activity.actorName, name: activity.entityTitle,
          type: activity.type, description: activity.description }] : [];
      }),
    ];
    const stale = staleCandidates(candidates, now);
    if (!run) {
      const curriculum = await Promise.all(stale.filter(c => c.kind === "category").map(async category => {
        const courses = await db.select().from(coursesTable)
          .where(eq(coursesTable.categoryId, Number(category.id)));
        return { run: category.run, categoryId: category.id,
          courses: await Promise.all(courses.map(async course => ({
            id: course.id, title: course.title,
            lessonIds: (await db.select({ id: lessonsTable.id }).from(lessonsTable)
              .where(eq(lessonsTable.courseId, course.id))).map(lesson => lesson.id),
          }))) };
      }));
      log(JSON.stringify({
        candidates: stale.map(({ kind, id, run, createdAt, marker, type, description }) =>
          ({ kind, id, run, createdAt, marker, ...(kind === "activity" ? { type, description } : {}) })),
        curriculum,
      }, null, 2));
      log(`${stale.length} stale disposable record(s). Dry run only; nothing deleted.`);
      return;
    }
    const selected = eligibleRun(candidates, now, run);
    const categoriesForRun = selected.filter(c => c.kind === "category");
    const identitiesForRun = selected.filter(c => c.kind === "clerk");
    const membersForRun = selected.filter(c => c.kind === "member");
    const activitiesForRun = selected.filter(c => c.kind === "activity");
    if (categoriesForRun.length > 1 || identitiesForRun.length > 2 || membersForRun.length > 2 ||
        membersForRun.some(m => identitiesForRun.some(i => i.id === m.id && i.marker !== m.marker))) {
      throw new Error("Unexpected run records; review manually rather than deleting");
    }
    const ids = [...new Set([...identitiesForRun, ...membersForRun].map(identity => identity.id))];
    const matchingMembers = members.filter(member => ids.includes(member.clerkId));
    if (matchingMembers.length !== membersForRun.length) {
      throw new Error("A Clerk identity has a non-fixture member record; refusing deletion");
    }
    const category = categoriesForRun[0];
    const courseRows = category
      ? await db.select().from(coursesTable).where(eq(coursesTable.categoryId, Number(category.id)))
      : [];
    if (courseRows.length > 1 || courseRows.some(course =>
      course.title !== "The Beauty Mindset Accelerator" ||
      course.description !== "Temporary browser progress check" ||
      course.instructorName !== "Progress Check" || course.accessTier !== "Elevated")) {
      throw new Error("Category contains non-fixture curriculum; refusing deletion");
    }
    const course = courseRows[0];
    const lessons = course ? await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id)) : [];
    const cutoff = now.getTime() - 60 * 60 * 1000;
    if (course && course.createdAt.getTime() > cutoff ||
        lessons.some(lesson => lesson.createdAt.getTime() > cutoff)) {
      throw new Error("Curriculum includes recent records; refusing deletion");
    }
    if (lessons.length > 4 || lessons.some(lesson =>
      lesson.sortOrder < 1 || lesson.sortOrder > 4 ||
      lesson.title !== `Browser progress module ${lesson.sortOrder} ${run}` ||
      lesson.content !== `Private lesson for browser check ${lesson.sortOrder} ${run}`)) {
      throw new Error("Course contains non-fixture lessons; refusing deletion");
    }
    if (course) {
      const enrollments = await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.courseId, course.id));
      if (enrollments.some(enrollment => !ids.includes(enrollment.userId))) {
        throw new Error("Course has unrelated enrollments; refusing deletion");
      }
      for (const lesson of lessons) {
        const completions = await db.select().from(lessonCompletionsTable)
          .where(eq(lessonCompletionsTable.lessonId, lesson.id));
        if (completions.some(completion => !ids.includes(completion.userId))) {
          throw new Error("Course has unrelated completions; refusing deletion");
        }
      }
    }
    // Database changes are atomic. A foreign-key conflict means a human must
    // review additional records; never cascade through unrelated data.
    await db.transaction(async tx => {
      for (const id of ids) {
        await tx.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, id));
        await tx.delete(enrollmentsTable).where(eq(enrollmentsTable.userId, id));
      }
      for (const member of membersForRun) {
        await tx.delete(usersTable).where(and(
          eq(usersTable.clerkId, member.id), eq(usersTable.email, member.marker)));
      }
      if (course) {
        await tx.delete(lessonsTable).where(eq(lessonsTable.courseId, course.id));
        await tx.delete(coursesTable).where(eq(coursesTable.id, course.id));
      }
      if (category) await tx.delete(categoriesTable).where(eq(categoriesTable.id, Number(category.id)));
      for (const activity of activitiesForRun) {
        const removed = await tx.delete(activityTable).where(and(
          eq(activityTable.id, Number(activity.id)),
          eq(activityTable.actorName, activity.marker),
          eq(activityTable.entityTitle, activity.name!),
          eq(activityTable.type, activity.type!),
          eq(activityTable.description, activity.description!),
          lte(activityTable.createdAt, new Date(cutoff)))).returning({ id: activityTable.id });
        if (removed.length !== 1) throw new Error("Activity changed during cleanup; refusing partial deletion");
      }
    });
    for (const identity of identitiesForRun) await deleteIdentity(identity.id);
    log(`Removed confirmed disposable records for ${run}. Re-run dry run to check for remaining Clerk users.`);
}

async function main() {
  const run = confirmedRun(process.argv.slice(2));
  progressBrowserEnvironment();
  const { clerkClient } = await import("@clerk/express");
  const { pool } = await import("@workspace/db");
  try {
    const identities: Identity[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await clerkClient.users.getUserList({ limit: 100, offset });
      for (const user of page.data) {
        identities.push({
          id: user.id, email: user.emailAddresses[0]?.emailAddress || "",
          name: user.firstName || "", createdAt: new Date(user.createdAt),
        });
      }
      if (offset + page.data.length >= page.totalCount || !page.data.length) break;
    }
    await inspectProgressLeftovers(run, identities, id => clerkClient.users.deleteUser(id));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}