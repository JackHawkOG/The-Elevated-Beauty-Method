import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cleanupCourseSwitchFixtures } from "./course-switch-fixtures-cleanup-core";
import {
  courseSwitchEmail, courseSwitchPrivateMetadata, courseSwitchTitle,
  newCourseSwitchTag, requireAuditDevelopment, staleCourseSwitchIdentity,
} from "./radiant-audit-fixtures";

const now = Date.now();
const old = new Date(now - 26 * 60 * 60 * 1000);
const env = {
  CLERK_SECRET_KEY: "sk_test_example", CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev", PGHOST: "development.db",
  PGPORT: "5432", PGDATABASE: "development", PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};

describe("course-switch fixture ownership", () => {
  const identity = {
    id: "test-id", emailAddresses: [{ emailAddress: courseSwitchEmail("a", "abcdef123456") }],
    privateMetadata: courseSwitchPrivateMetadata, publicMetadata: {},
    firstName: null, lastName: null, createdAt: old.getTime(),
  };

  it("requires old dedicated identities and rejects production before accessing Clerk or DB", async () => {
    const liveTag = newCourseSwitchTag();
    expect(liveTag).toMatch(/^[0-9a-f]{12}$/);
    expect(staleCourseSwitchIdentity({
      ...identity, emailAddresses: [{ emailAddress: courseSwitchEmail("a", liveTag) }],
    }, now)?.tag).toBe(liveTag);
    expect(staleCourseSwitchIdentity(identity, now)).toEqual({
      role: "a", tag: "abcdef123456", email: identity.emailAddresses[0].emailAddress,
    });
    expect(staleCourseSwitchIdentity({ ...identity, createdAt: now }, now)).toBeUndefined();
    expect(staleCourseSwitchIdentity({ ...identity, privateMetadata: {} }, now)).toBeUndefined();
    expect(staleCourseSwitchIdentity({ ...identity, privateMetadata: { ...courseSwitchPrivateMetadata, role: "owner" } }, now)).toBeUndefined();
    expect(staleCourseSwitchIdentity({ ...identity, publicMetadata: { role: "member" } }, now)).toBeUndefined();
    expect(staleCourseSwitchIdentity({ ...identity, emailAddresses: [...identity.emailAddresses, { emailAddress: "member@example.com" }] }, now)).toBeUndefined();
    expect(staleCourseSwitchIdentity({ ...identity, emailAddresses: [{ emailAddress: "audit-fixture-a-abcdef123456+clerk_test@example.com" }] }, now)).toBeUndefined();
    for (const unsafe of [
      { NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" },
      { CLERK_SECRET_KEY: "sk_live_example" }, { DATABASE_URL: "postgresql://dev@production.db/development" },
    ]) {
      const client = { getUserList: vi.fn(), getUser: vi.fn(), deleteUser: vi.fn() };
      await expect(cleanupCourseSwitchFixtures({
        client: client as never, db: {} as never, deleteRows: true, env: { ...env, ...unsafe }, now,
      })).rejects.toThrow();
      expect(client.getUserList).not.toHaveBeenCalled();
    }
  });
});

for (const secondMemberEnrolled of [false, true]) {
it(`reports only old owned rows, rejects changed ownership and deletes in dependency order (second member enrolled: ${secondMemberEnrolled})`, async () => {
  requireAuditDevelopment();
  const { db, pool, categoriesTable, coursesTable, lessonsTable, enrollmentsTable, lessonCompletionsTable, usersTable } =
    await import("../../../lib/db/src/index");
  const { eq } = await import("drizzle-orm");
  const tag = newCourseSwitchTag();
  const title = courseSwitchTitle(tag);
  const bTitle = `Course-switch member B check ${tag}`;
  const ids = [`course-switch-a-${randomUUID()}`, `course-switch-b-${randomUUID()}`];
  const identities = ids.map((id, index) => ({
    id, emailAddresses: [{ emailAddress: courseSwitchEmail(index ? "b" : "a", tag) }],
    privateMetadata: courseSwitchPrivateMetadata, publicMetadata: {},
    firstName: null, lastName: null, createdAt: old.getTime(),
  }));
  const young = { ...identities[1], id: `young-${randomUUID()}`, createdAt: now };
  const unmarked = { ...identities[1], id: `unmarked-${randomUUID()}`, privateMetadata: {} };
  let listed: Array<(typeof identities)[number] | typeof unmarked> = [...identities, young];
  const client = {
    getUserList: vi.fn(async () => ({ data: listed, totalCount: listed.length })),
    getUser: vi.fn(async (id: string) => {
      const user = listed.find(item => item.id === id);
      if (!user) throw new Error("Unknown identity");
      return user;
    }),
    deleteUser: vi.fn(async (id: string) => { listed = listed.filter(item => item.id !== id); }),
  };
  let categoryId: number | undefined;
  let courseId: number | undefined;
  const courseIds: number[] = [];
  const lessonIds: number[] = [];
  try {
    await db.insert(usersTable).values(identities.map(identity => ({
      clerkId: identity.id, email: identity.emailAddresses[0].emailAddress,
      displayName: "New Learner", createdAt: old,
    })));
    const [category] = await db.insert(categoriesTable).values({
      name: title, slug: `course-switch-${tag}`, createdAt: old,
    }).returning();
    categoryId = category.id;
    const [course] = await db.insert(coursesTable).values({
      categoryId, title, description: title, instructorName: "Test learner",
      accessTier: "Free", publishedAt: old, createdAt: old,
    }).returning();
    courseId = course.id;
    courseIds.push(course.id);
    const lessons = await db.insert(lessonsTable).values([0, 1].map(sortOrder => ({
      courseId: course.id, title: `${title} lesson ${sortOrder + 1}`,
      sortOrder, publishedAt: old, createdAt: old,
    }))).returning();
    lessonIds.push(...lessons.map(row => row.id));
    await db.insert(enrollmentsTable).values({
      userId: ids[0], courseId: course.id, completedLessons: 1,
      lastLessonId: lessons[0].id, enrolledAt: old,
    });
    await db.insert(lessonCompletionsTable).values({ userId: ids[0], lessonId: lessons[0].id, completedAt: old });
    if (secondMemberEnrolled) {
      const [bCourse] = await db.insert(coursesTable).values({
        categoryId, title: bTitle, description: bTitle, instructorName: "Test learner",
        accessTier: "Free", publishedAt: old, createdAt: old,
      }).returning();
      courseIds.push(bCourse.id);
      const bLessons = await db.insert(lessonsTable).values([0, 1, 2].map(sortOrder => ({
        courseId: bCourse.id, title: `${bTitle} lesson ${sortOrder + 1}`,
        sortOrder, publishedAt: old, createdAt: old,
      }))).returning();
      lessonIds.push(...bLessons.map(row => row.id));
      const [bEnrollment] = await db.insert(enrollmentsTable).values({
        userId: ids[1], courseId: bCourse.id, completedLessons: 2,
        lastLessonId: bLessons[1].id, enrolledAt: old,
      }).returning();
      await db.insert(lessonCompletionsTable).values(bLessons.slice(0, 2).map(lesson => ({
        userId: ids[1], lessonId: lesson.id, completedAt: old,
      })));
      // A recognizable title alone cannot authorize deleting unexpected progress.
      listed = [...identities];
      await db.update(enrollmentsTable).set({ completedLessons: 3 }).where(eq(enrollmentsTable.id, bEnrollment.id));
      await expect(cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now })).rejects.toThrow("Ambiguous course-switch learning progress");
      expect(client.deleteUser).not.toHaveBeenCalled();
      await db.update(enrollmentsTable).set({ completedLessons: 2 }).where(eq(enrollmentsTable.id, bEnrollment.id));
      listed = [...identities, young];
    }

    // A same-tag young identity makes the group ambiguous; no deletion is permitted.
    await expect(cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now })).rejects.toThrow("Ambiguous course-switch identities");
    listed = [...identities];
    await cleanupCourseSwitchFixtures({ client, db, now });
    expect(client.deleteUser).not.toHaveBeenCalled();
    expect(await db.select().from(coursesTable).where(eq(coursesTable.id, courseId))).toHaveLength(1);

    await db.update(coursesTable).set({ description: "A real course" }).where(eq(coursesTable.id, courseId));
    await expect(cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now })).rejects.toThrow("Ambiguous course-switch course");
    expect(client.deleteUser).not.toHaveBeenCalled();
    await db.update(coursesTable).set({ description: title }).where(eq(coursesTable.id, courseId));
    const [intruder] = await db.insert(enrollmentsTable).values({
      userId: `real-${randomUUID()}`, courseId, completedLessons: 0, enrolledAt: old,
    }).returning();
    await expect(cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now })).rejects.toThrow("Ambiguous course-switch learning progress");
    await db.delete(enrollmentsTable).where(eq(enrollmentsTable.id, intruder.id));
    listed = [...identities, unmarked];
    await expect(cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now })).rejects.toThrow("Ambiguous course-switch identities");
    listed = [...identities];

    await cleanupCourseSwitchFixtures({ client, db, deleteRows: true, now });
    expect(client.deleteUser).toHaveBeenCalledTimes(2);
    expect(await db.select().from(categoriesTable).where(eq(categoriesTable.id, categoryId))).toEqual([]);
    expect(await db.select().from(coursesTable).where(eq(coursesTable.id, courseId))).toEqual([]);
    for (const id of courseIds) {
      expect(await db.select().from(coursesTable).where(eq(coursesTable.id, id))).toEqual([]);
    }
    expect(await db.select().from(usersTable).where(eq(usersTable.clerkId, ids[0]))).toEqual([]);
  } finally {
    await pool.query("DELETE FROM lesson_completions WHERE lesson_id = ANY($1::int[])", [lessonIds]);
    await pool.query("DELETE FROM enrollments WHERE course_id = ANY($1::int[])", [courseIds]);
    await pool.query("DELETE FROM lessons WHERE course_id = ANY($1::int[])", [courseIds]);
    await pool.query("DELETE FROM courses WHERE id = ANY($1::int[])", [courseIds]);
    await pool.query("DELETE FROM categories WHERE id = $1", [categoryId ?? -1]);
    await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [ids]);
  }
}, 30_000);
}