import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { User as ClerkUser } from "@clerk/backend";
import type { db as database } from "../../../lib/db/src/index";
import {
  activityTable, announcementActivityCorrectionsTable, announcementsTable,
  categoriesTable, coursesTable, enrollmentsTable, lessonCompletionsTable, lessonsTable,
  memberStoriesTable, memberStoryReviewCorrectionsTable, radiantAuditDraftsTable, radiantAuditHistoryTable,
  radiantAuditSubmissionsTable, radiantAuditsTable, usersTable,
} from "../../../lib/db/src/schema";
import { courseSwitchPrivateMetadata, requireAuditDevelopment } from "./radiant-audit-fixtures";

// Same development guard, explicit Clerk ownership, unchanged course graph and
// no unrelated member content as course-switch-fixtures-cleanup. This run owns
// fresh records, so it uses returned IDs/snapshots rather than the stale scanner.
export async function cleanupEnrollmentReplyFixture({
  client, db, userId, email, title, category, course, lessons, member,
}: {
  client: {
    getUser(id: string): Promise<Pick<ClerkUser, "privateMetadata" | "publicMetadata" | "firstName" | "lastName" | "emailAddresses">>;
    deleteUser(id: string): Promise<unknown>;
  };
  db: typeof database; userId: string; email: string; title: string;
  category?: typeof categoriesTable.$inferSelect;
  course?: typeof coursesTable.$inferSelect;
  lessons: Array<typeof lessonsTable.$inferSelect>;
  member?: typeof usersTable.$inferSelect;
}) {
  const verifyIdentity = async () => {
    requireAuditDevelopment();
    const identity = await client.getUser(userId);
    if (!isDeepStrictEqual(identity.privateMetadata, courseSwitchPrivateMetadata) ||
        Object.keys(identity.publicMetadata).length || identity.firstName !== null ||
        identity.lastName !== null || identity.emailAddresses.length !== 1 ||
        identity.emailAddresses[0].emailAddress !== email) {
      throw new Error("Refusing cleanup of a changed enrollment-reply fixture identity");
    }
  };
  await verifyIdentity();
  await db.transaction(async tx => {
    // Brief development-only lock closes the check/delete gap, including tables
    // with user references but no FK. Never use this as production deletion.
    await tx.execute(sql`LOCK TABLE categories, courses, lessons, enrollments,
      lesson_completions, users, activity, announcement_activity_corrections,
      announcements, member_stories, member_story_review_corrections, radiant_audits, radiant_audit_drafts,
      radiant_audit_history, radiant_audit_submissions IN SHARE ROW EXCLUSIVE MODE`);
    const refuse = () => { throw new Error("Refusing cleanup of changed or non-fixture enrollment data"); };
    if (category) {
      const current = await tx.select().from(categoriesTable).where(eq(categoriesTable.id, category.id));
      if (!isDeepStrictEqual(current, [category])) refuse();
      const courses = await tx.select().from(coursesTable).where(eq(coursesTable.categoryId, category.id));
      if (!isDeepStrictEqual(courses, course ? [course] : [])) refuse();
    }
    if (course) {
      const current = await tx.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id)).orderBy(lessonsTable.id);
      if (!isDeepStrictEqual(current, [...lessons].sort((a, b) => a.id - b.id))) refuse();
    }
    const enrollments = await tx.select().from(enrollmentsTable).where(
      course ? or(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)) : eq(enrollmentsTable.userId, userId),
    );
    if (enrollments.length > 1 || enrollments.some(row =>
      row.userId !== userId || row.courseId !== course?.id ||
      row.completedLessons !== 0 || row.lastLessonId !== null)) refuse();
    const completions = await tx.select().from(lessonCompletionsTable).where(or(
      eq(lessonCompletionsTable.userId, userId),
      inArray(lessonCompletionsTable.lessonId, lessons.map(row => row.id)),
    ));
    if (completions.length) refuse();
    const activity = await tx.select().from(activityTable).where(or(
      eq(activityTable.entityTitle, title), eq(activityTable.sourceReviewedBy, userId),
    ));
    if (activity.length > 1 || activity.some(row =>
      row.type !== "enrollment" || row.entityTitle !== title || row.actorName !== "New Learner" ||
      row.description !== "enrolled in a course" ||
      row.sourceAnnouncementId !== null || row.sourceEvidence !== null ||
      row.sourceReviewedBy !== null || row.sourceReviewedAt !== null) ||
      activity.length !== enrollments.length) refuse();
    const members = await tx.select().from(usersTable).where(eq(usersTable.clerkId, userId));
    if (member ? !isDeepStrictEqual(members, [member]) : members.some(row =>
      row.email !== email || row.displayName !== "New Learner" || row.membershipTier !== "Free" ||
      row.bio !== null || row.avatarUrl !== null || row.skinType !== null || row.undertone !== null ||
      row.featureNeeds !== null || row.lifeStage !== null || row.visibilityGoal !== null)) refuse();
    const material = await Promise.all([
      tx.select().from(announcementsTable).where(eq(announcementsTable.actorId, userId)),
      tx.select().from(announcementActivityCorrectionsTable).where(or(
        eq(announcementActivityCorrectionsTable.correctedBy, userId),
        eq(announcementActivityCorrectionsTable.previousReviewedBy, userId),
        inArray(announcementActivityCorrectionsTable.activityId, activity.map(row => row.id)),
      )),
      tx.select().from(memberStoriesTable).where(or(
        eq(memberStoriesTable.permissionRecordedBy, userId), eq(memberStoriesTable.withdrawnBy, userId),
        eq(memberStoriesTable.removalRequestedBy, userId), eq(memberStoriesTable.removalReviewedBy, userId),
      )),
      tx.select().from(memberStoryReviewCorrectionsTable).where(eq(memberStoryReviewCorrectionsTable.reviewedBy, userId)),
      tx.select().from(radiantAuditsTable).where(eq(radiantAuditsTable.clerkId, userId)),
      tx.select().from(radiantAuditDraftsTable).where(eq(radiantAuditDraftsTable.clerkId, userId)),
      tx.select().from(radiantAuditHistoryTable).where(eq(radiantAuditHistoryTable.clerkId, userId)),
      tx.select().from(radiantAuditSubmissionsTable).where(eq(radiantAuditSubmissionsTable.clerkId, userId)),
    ]);
    if (material.some(rows => rows.length)) refuse();
    if (activity.length) await tx.delete(activityTable).where(eq(activityTable.id, activity[0].id));
    if (enrollments.length) await tx.delete(enrollmentsTable).where(and(
      eq(enrollmentsTable.id, enrollments[0].id), eq(enrollmentsTable.userId, userId),
    ));
    if (lessons.length) await tx.delete(lessonsTable).where(inArray(lessonsTable.id, lessons.map(row => row.id)));
    if (course) await tx.delete(coursesTable).where(eq(coursesTable.id, course.id));
    if (category) await tx.delete(categoriesTable).where(eq(categoriesTable.id, category.id));
    if (members.length) await tx.delete(usersTable).where(eq(usersTable.clerkId, userId));
  });
  // Ownership outages are not absence. Keep the account for an explicit retry
  // if this check fails, even though the local transaction has already committed.
  await verifyIdentity();
  await client.deleteUser(userId);
}