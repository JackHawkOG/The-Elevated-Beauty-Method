import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { cleanupEnrollmentReplyFixture } from "./course-enrollment-live-cleanup";
import {
  courseSwitchEmail, courseSwitchPrivateMetadata, courseSwitchTitle,
  newCourseSwitchTag, requireAuditDevelopment,
} from "./radiant-audit-fixtures";

test.each(["unchanged", "changed course", "foreign enrollment", "changed identity"] as const)(
  "enrollment-reply cleanup preserves non-fixtures: %s", async change => {
    requireAuditDevelopment();
    const [{ db, categoriesTable, coursesTable, lessonsTable, enrollmentsTable, activityTable, usersTable }, { eq, inArray }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    const tag = newCourseSwitchTag();
    const email = courseSwitchEmail("a", tag);
    const title = courseSwitchTitle(tag);
    const userId = `enrollment-reply-cleanup-${randomUUID()}`;
    const categoryIds: number[] = [];
    const courseIds: number[] = [];
    const client = {
      getUser: vi.fn(async () => ({
        privateMetadata: change === "changed identity" ? {} : courseSwitchPrivateMetadata,
        publicMetadata: {}, firstName: null, lastName: null,
        emailAddresses: [{ emailAddress: email }],
      })),
      deleteUser: vi.fn(async () => {}),
    };
    const snapshot = async () => ({
      categories: await db.select().from(categoriesTable).where(inArray(categoriesTable.id, categoryIds)).orderBy(categoriesTable.id),
      courses: await db.select().from(coursesTable).where(inArray(coursesTable.id, courseIds)).orderBy(coursesTable.id),
      lessons: await db.select().from(lessonsTable).where(inArray(lessonsTable.courseId, courseIds)).orderBy(lessonsTable.id),
      enrollments: await db.select().from(enrollmentsTable).where(inArray(enrollmentsTable.courseId, courseIds)).orderBy(enrollmentsTable.id),
      activity: await db.select().from(activityTable).where(eq(activityTable.entityTitle, title)),
      members: await db.select().from(usersTable).where(eq(usersTable.clerkId, userId)),
    });
    try {
      const [member] = await db.insert(usersTable).values({ clerkId: userId, email, displayName: "New Learner" }).returning();
      const [category] = await db.insert(categoriesTable).values({ name: title, slug: `course-switch-${tag}` }).returning();
      categoryIds.push(category.id);
      const [course] = await db.insert(coursesTable).values({
        title, description: title, categoryId: category.id, instructorName: "Test learner",
        accessTier: "Free", publishedAt: new Date(),
      }).returning();
      courseIds.push(course.id);
      const lessons = await db.insert(lessonsTable).values([0, 1].map(sortOrder => ({
        courseId: course.id, title: `${title} lesson ${sortOrder + 1}`, sortOrder, publishedAt: new Date(),
      }))).returning();
      await db.insert(enrollmentsTable).values({ userId, courseId: course.id });
      await db.insert(activityTable).values({
        type: "enrollment", description: "enrolled in a course", actorName: "New Learner", entityTitle: title,
      });
      // A distinct course graph must survive even a successful cleanup.
      const [otherCategory] = await db.insert(categoriesTable).values({ name: `Unrelated ${tag}`, slug: `unrelated-${tag}` }).returning();
      categoryIds.push(otherCategory.id);
      const [otherCourse] = await db.insert(coursesTable).values({
        title: `Unrelated ${tag}`, description: "Not owned by this member", categoryId: otherCategory.id,
        instructorName: "Other learner",
      }).returning();
      courseIds.push(otherCourse.id);
      if (change === "changed course") await db.update(coursesTable).set({ description: "Edited elsewhere" }).where(eq(coursesTable.id, course.id));
      if (change === "foreign enrollment") await db.insert(enrollmentsTable).values({ userId: `foreign-${userId}`, courseId: course.id });
      const before = await snapshot();
      const cleanup = () => cleanupEnrollmentReplyFixture({
        client: client as unknown as Parameters<typeof cleanupEnrollmentReplyFixture>[0]["client"],
        db, userId, email, title, category, course, lessons, member,
      });
      if (change === "unchanged") {
        await cleanup();
        expect(await snapshot()).toEqual({
          categories: [otherCategory], courses: [otherCourse], lessons: [],
          enrollments: [], activity: [], members: [],
        });
        expect(client.getUser).toHaveBeenCalledTimes(2);
        expect(client.deleteUser).toHaveBeenCalledWith(userId);
      } else {
        await expect(cleanup()).rejects.toThrow(/Refusing cleanup/);
        expect(await snapshot()).toEqual(before);
        expect(client.deleteUser).not.toHaveBeenCalled();
      }
    } finally {
      requireAuditDevelopment();
      // IDs were returned by this isolated test's inserts; no remote users exist.
      await db.transaction(async tx => {
        await tx.delete(activityTable).where(eq(activityTable.entityTitle, title));
        await tx.delete(enrollmentsTable).where(inArray(enrollmentsTable.courseId, courseIds));
        await tx.delete(lessonsTable).where(inArray(lessonsTable.courseId, courseIds));
        await tx.delete(coursesTable).where(inArray(coursesTable.id, courseIds));
        await tx.delete(categoriesTable).where(inArray(categoriesTable.id, categoryIds));
        await tx.delete(usersTable).where(eq(usersTable.clerkId, userId));
      });
    }
  },
);