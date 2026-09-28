import { eq, inArray, or } from "drizzle-orm";
import type { db as database } from "../../../lib/db/src/index";
import {
  activityTable, announcementsTable, categoriesTable, coursesTable, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, memberStoriesTable, radiantAuditDraftsTable,
  radiantAuditHistoryTable, radiantAuditSubmissionsTable, radiantAuditsTable, usersTable,
} from "../../../lib/db/src/schema";
import {
  courseSwitchTitle, isOldCourseSwitchDate, requireAuditDevelopment, staleCourseSwitchIdentity,
  type CourseSwitchIdentity,
} from "./radiant-audit-fixtures";

type Identity = CourseSwitchIdentity & { id: string };
type Client = {
  getUserList(options: { limit: number; offset: number }): Promise<{ data: Identity[]; totalCount: number }>;
  getUser(id: string): Promise<Identity>;
  deleteUser(id: string): Promise<unknown>;
};

export async function cleanupCourseSwitchFixtures({
  client, db, deleteRows = false, env = process.env, now = Date.now(),
}: {
  client: Client; db: typeof database; deleteRows?: boolean; env?: NodeJS.ProcessEnv; now?: number;
}) {
  requireAuditDevelopment(env);
  const groups = new Map<string, Array<{ id: string; role: "a" | "b"; email: string }>>();
  const conflictingTags = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const page = await client.getUserList({ limit: 100, offset });
    for (const user of page.data) {
      const fixture = staleCourseSwitchIdentity(user, now);
      for (const address of user.emailAddresses) {
        const match = /^course-switch-[ab]-([0-9a-f]{12})\+clerk_test@example\.com$/.exec(address.emailAddress);
        if (match && !fixture) conflictingTags.add(match[1]);
      }
      if (!fixture) continue;
      const group = groups.get(fixture.tag) ?? [];
      group.push({ id: user.id, role: fixture.role, email: fixture.email });
      groups.set(fixture.tag, group);
    }
    if (!page.data.length || offset + page.data.length >= page.totalCount) break;
  }
  for (const [tag, candidates] of groups) {
    requireAuditDevelopment(env);
    if (conflictingTags.has(tag)) throw new Error(`Ambiguous course-switch identities for ${tag}`);
    if (new Set(candidates.map(candidate => candidate.role)).size !== candidates.length) {
      throw new Error(`Ambiguous course-switch identities for ${tag}`);
    }
    // Recheck Clerk before touching the database. A partially deleted pair is valid;
    // a changed or young account is not.
    for (const candidate of candidates) {
      const fixture = staleCourseSwitchIdentity(await client.getUser(candidate.id), now);
      if (!fixture || fixture.tag !== tag || fixture.role !== candidate.role || fixture.email !== candidate.email) {
        throw new Error(`Course-switch fixture identity changed: ${candidate.id}`);
      }
    }
    await db.transaction(async tx => {
      const title = courseSwitchTitle(tag);
      const categories = await tx.select().from(categoriesTable).where(eq(categoriesTable.slug, `course-switch-${tag}`));
      if (categories.some(row => row.name !== title || row.icon !== "BookOpen" ||
          row.description !== null || !isOldCourseSwitchDate(row.createdAt, now))) {
        throw new Error(`Ambiguous course-switch category for ${tag}`);
      }
      const category = categories[0];
      const courses = category ? await tx.select().from(coursesTable).where(eq(coursesTable.categoryId, category.id)) : [];
      if (courses.length > 1 || courses.some(row =>
        row.title !== title || row.description !== title || row.instructorName !== "Test learner" ||
        row.difficulty !== "Beginner" || row.thumbnailUrl !== null || row.isFeatured !== false ||
        row.accessTier !== "Free" || row.transformationStory !== null ||
        !row.publishedAt || !isOldCourseSwitchDate(row.createdAt, now) ||
        !isOldCourseSwitchDate(row.publishedAt, now))) {
        throw new Error(`Ambiguous course-switch course for ${tag}`);
      }
      const course = courses[0];
      const courseActivity = await tx.select().from(activityTable).where(eq(activityTable.entityTitle, title));
      if (courseActivity.length) throw new Error(`Ambiguous course-switch activity for ${tag}`);
      const lessons = course ? await tx.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id)) : [];
      if (lessons.length > 2 || new Set(lessons.map(row => row.sortOrder)).size !== lessons.length ||
          lessons.some(row => ![0, 1].includes(row.sortOrder) ||
            row.title !== `${title} lesson ${row.sortOrder + 1}` || row.content !== null ||
            row.videoUrl !== null || row.durationMinutes !== 10 || !row.publishedAt ||
            !isOldCourseSwitchDate(row.createdAt, now) || !isOldCourseSwitchDate(row.publishedAt, now))) {
        throw new Error(`Ambiguous course-switch lesson for ${tag}`);
      }
      const ids = candidates.map(candidate => candidate.id);
      const a = candidates.find(candidate => candidate.role === "a");
      const enrollments = course ? await tx.select().from(enrollmentsTable).where(eq(enrollmentsTable.courseId, course.id)) : [];
      const otherEnrollments = await tx.select().from(enrollmentsTable).where(inArray(enrollmentsTable.userId, ids));
      const completions = lessons.length
        ? await tx.select().from(lessonCompletionsTable).where(inArray(lessonCompletionsTable.lessonId, lessons.map(row => row.id)))
        : [];
      const otherCompletions = await tx.select().from(lessonCompletionsTable).where(inArray(lessonCompletionsTable.userId, ids));
      if (enrollments.length > 1 || enrollments.some(row =>
        !a || row.userId !== a.id || row.completedLessons !== 1 || row.lastLessonId !== lessons.find(lesson => lesson.sortOrder === 0)?.id ||
        !isOldCourseSwitchDate(row.enrolledAt, now)) ||
        otherEnrollments.some(row => row.courseId !== course?.id) ||
        completions.length > 1 || completions.some(row =>
          !a || row.userId !== a.id || row.lessonId !== lessons.find(lesson => lesson.sortOrder === 0)?.id ||
          !isOldCourseSwitchDate(row.completedAt, now)) ||
        otherCompletions.some(row => !lessons.some(lesson => lesson.id === row.lessonId))) {
        throw new Error(`Ambiguous course-switch learning progress for ${tag}`);
      }
      const members = await tx.select().from(usersTable).where(inArray(usersTable.clerkId, ids));
      if (members.some(row => row.email !== candidates.find(candidate => candidate.id === row.clerkId)?.email ||
          row.displayName !== "New Learner" || row.membershipTier !== "Free" ||
          row.bio !== null || row.avatarUrl !== null || row.skinType !== null ||
          row.undertone !== null || row.featureNeeds !== null || row.lifeStage !== null ||
          row.visibilityGoal !== null || !isOldCourseSwitchDate(row.createdAt, now))) {
        throw new Error(`Ambiguous course-switch member for ${tag}`);
      }
      // No other member-created material may be removed or orphaned. Reject it,
      // including references without a foreign key to users.
      for (const id of ids) {
        const [posts, reviews, stories, audits, drafts, history, submissions] = await Promise.all([
          tx.select().from(announcementsTable).where(eq(announcementsTable.actorId, id)),
          tx.select().from(activityTable).where(eq(activityTable.sourceReviewedBy, id)),
          tx.select({ id: memberStoriesTable.id }).from(memberStoriesTable).where(or(
            eq(memberStoriesTable.permissionRecordedBy, id), eq(memberStoriesTable.withdrawnBy, id),
            eq(memberStoriesTable.removalRequestedBy, id), eq(memberStoriesTable.removalReviewedBy, id))),
          tx.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, id)),
          tx.select().from(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, id)),
          tx.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, id)),
          tx.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, id)),
        ]);
        if (posts.length || reviews.length || stories.length || audits.length || drafts.length || history.length || submissions.length) {
          throw new Error(`Non-fixture member content for ${id}`);
        }
      }
      console.log(`${deleteRows ? "Removing" : "Would remove"} course-switch ${tag}: ${candidates.length} identities, ${categories.length} categories, ${courses.length} courses, ${lessons.length} lessons, ${enrollments.length} enrollments, ${completions.length} completions, ${members.length} members`);
      if (!deleteRows) return;
      if (completions.length) await tx.delete(lessonCompletionsTable).where(inArray(lessonCompletionsTable.lessonId, completions.map(row => row.lessonId)));
      if (enrollments.length) await tx.delete(enrollmentsTable).where(inArray(enrollmentsTable.id, enrollments.map(row => row.id)));
      if (lessons.length) await tx.delete(lessonsTable).where(inArray(lessonsTable.id, lessons.map(row => row.id)));
      if (course) await tx.delete(coursesTable).where(eq(coursesTable.id, course.id));
      if (category) await tx.delete(categoriesTable).where(eq(categoriesTable.id, category.id));
      if (members.length) await tx.delete(usersTable).where(inArray(usersTable.id, members.map(row => row.id)));
    });
    // Database first, Clerk second. A failed Clerk request remains retryable.
    if (deleteRows) for (const candidate of candidates) {
      requireAuditDevelopment(env);
      const fixture = staleCourseSwitchIdentity(await client.getUser(candidate.id), now);
      if (!fixture || fixture.tag !== tag || fixture.role !== candidate.role || fixture.email !== candidate.email) {
        throw new Error(`Course-switch fixture identity changed: ${candidate.id}`);
      }
      await client.deleteUser(candidate.id);
    }
  }
  if (!groups.size) console.log("No stale marked course-switch fixtures found.");
  if (!deleteRows) console.log("Dry run; nothing deleted. Pass --delete to remove these fixtures.");
}