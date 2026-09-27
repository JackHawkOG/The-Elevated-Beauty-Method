import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityTable, categoriesTable, coursesTable, db, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, pool, usersTable,
} from "@workspace/db";

// Exercise the actual requireAuth middleware and route guards. Only the isolated
// test server replaces Clerk's session lookup and public-metadata lookup.
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: {
    users: {
      getUser: async (id: string) => ({
        publicMetadata: { role: id.startsWith("test-owner-") ? "owner" : id.startsWith("test-editor-") ? "editor" : "member" },
      }),
    },
  },
}));

const run = randomUUID();
const member = `test-member-${run}`;
const editor = `test-editor-${run}`;
const owner = `test-owner-${run}`;
const title = `Publication regression ${run}`;
let server: Server;
let baseUrl: string;
let categoryId: number;
const courseIds: number[] = [];

type ApiResult = { status: number; data: any };

async function request(user: string | null, path: string, method = "GET", body?: object): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

const courseCopy = (description: string) => ({
  title, description, categoryId, difficulty: "Beginner", instructorName: "Test",
  accessTier: "Free", isFeatured: true,
});
const lessonCopy = (content: string) => ({
  title: `Lesson ${run}`, content, sortOrder: 1, durationMinutes: 10,
});

async function revision(user: string, path: string): Promise<string> {
  const result = await request(user, path);
  expect(result.status).toBe(200);
  expect(result.data.revision).toMatch(/^[a-f0-9]{64}$/);
  return result.data.revision;
}

async function assertCourseHidden(courseId: number, lessonId?: number) {
  const catalog = await request(member, `/courses?search=${encodeURIComponent(title)}`);
  expect(catalog.status).toBe(200);
  expect(catalog.data.some((row: { id: number }) => row.id === courseId)).toBe(false);
  const featured = await request(member, "/dashboard/featured");
  expect(featured.status).toBe(200);
  expect(featured.data.some((row: { id: number }) => row.id === courseId)).toBe(false);
  expect((await request(member, `/courses/${courseId}`)).status).toBe(404);
  expect((await request(member, `/courses/${courseId}/lessons`)).status).toBe(404);
  expect((await request(member, "/enrollments", "POST", { courseId })).status).toBe(404);
  const enrollments = await request(member, "/enrollments");
  expect(enrollments.status).toBe(200);
  expect(enrollments.data.some((row: { courseId: number }) => row.courseId === courseId)).toBe(false);
  if (lessonId) {
    expect((await request(member, `/lessons/${lessonId}`)).status).toBe(404);
    expect((await request(member, `/enrollments/${courseId}/progress`, "PATCH", { lessonId })).status).not.toBe(200);
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Publication integration tests must only run against a development database");
  }
  const [{ default: courses }, { default: enrollments }, { default: dashboard }] = await Promise.all([
    import("./courses"), import("./enrollments"), import("./dashboard"),
  ]);
  const app = express();
  app.use(express.json(), courses, enrollments, dashboard);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [category] = await db.insert(categoriesTable).values({
    name: `Publication test ${run}`, slug: `publication-test-${run}`,
  }).returning();
  categoryId = category.id;
  await db.insert(usersTable).values([
    { clerkId: member, displayName: "Test Member", email: `${member}@example.invalid`, membershipTier: "Free" },
    { clerkId: editor, displayName: "Test Editor", email: `${editor}@example.invalid`, membershipTier: "Free" },
    { clerkId: owner, displayName: "Test Owner", email: `${owner}@example.invalid`, membershipTier: "Free" },
  ]);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (courseIds.length) {
    const lessons = await db.select({ id: lessonsTable.id }).from(lessonsTable).where(inArray(lessonsTable.courseId, courseIds));
    if (lessons.length) await db.delete(lessonCompletionsTable).where(inArray(lessonCompletionsTable.lessonId, lessons.map(row => row.id)));
    await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.courseId, courseIds));
    await db.delete(lessonsTable).where(inArray(lessonsTable.courseId, courseIds));
    await db.delete(coursesTable).where(inArray(coursesTable.id, courseIds));
    await db.delete(activityTable).where(and(eq(activityTable.entityTitle, title), eq(activityTable.actorName, "Test Member")));
  }
  if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
  for (const user of [member, editor, owner]) await db.delete(usersTable).where(eq(usersTable.clerkId, user));
  await pool.end();
});

test("only editors can draft and only owners can publish; drafts and withdrawn copy never reach members", async () => {
  expect((await request(null, "/courses", "POST", courseCopy("Unauthorized"))).status).toBe(401);
  expect((await request(member, "/courses", "POST", courseCopy("Unauthorized"))).status).toBe(403);
  const created = await request(editor, "/courses", "POST", courseCopy("Initial draft"));
  expect(created.status).toBe(201);
  const courseId: number = created.data.id;
  courseIds.push(courseId);

  expect((await request(member, `/courses/${courseId}`, "PATCH", courseCopy("Member edit"))).status).toBe(403);
  expect((await request(member, `/courses/${courseId}/lessons`, "POST", lessonCopy("Member lesson"))).status).toBe(403);
  expect((await request(member, `/editorial/courses/${courseId}`)).status).toBe(403);
  expect((await request(member, `/courses/${courseId}/approve`, "POST", { revision: "a".repeat(64) })).status).toBe(403);

  const lesson = await request(editor, `/courses/${courseId}/lessons`, "POST", lessonCopy("Initial draft lesson"));
  expect(lesson.status).toBe(201);
  const lessonId: number = lesson.data.id;
  expect((await request(member, `/lessons/${lessonId}`, "PATCH", lessonCopy("Member edit"))).status).toBe(403);
  expect((await request(member, `/editorial/lessons/${lessonId}`)).status).toBe(403);
  expect((await request(member, `/lessons/${lessonId}/approve`, "POST", { revision: "a".repeat(64) })).status).toBe(403);

  const statsBefore = await request(member, "/dashboard/stats");
  expect(statsBefore.status).toBe(200);
  await assertCourseHidden(courseId, lessonId);
  expect((await request(member, "/dashboard/stats")).data).toEqual(statsBefore.data);

  const oldCourseRevision = await revision(owner, `/editorial/courses/${courseId}`);
  const oldLessonRevision = await revision(owner, `/editorial/lessons/${lessonId}`);
  expect((await request(editor, `/courses/${courseId}/approve`, "POST", { revision: oldCourseRevision })).status).toBe(403);
  expect((await request(editor, `/lessons/${lessonId}/approve`, "POST", { revision: oldLessonRevision })).status).toBe(403);
  expect((await request(editor, `/courses/${courseId}`, "PATCH", courseCopy("Revised draft"))).status).toBe(200);
  expect((await request(editor, `/lessons/${lessonId}`, "PATCH", lessonCopy("Revised draft lesson"))).status).toBe(200);
  expect((await request(owner, `/courses/${courseId}/approve`, "POST", { revision: oldCourseRevision })).status).toBe(409);
  expect((await request(owner, `/lessons/${lessonId}/approve`, "POST", { revision: oldLessonRevision })).status).toBe(409);
  await assertCourseHidden(courseId, lessonId);

  const courseRevision = await revision(owner, `/editorial/courses/${courseId}`);
  expect((await request(owner, `/courses/${courseId}/approve`, "POST", { revision: courseRevision })).status).toBe(200);
  expect((await request(member, `/courses?search=${encodeURIComponent(title)}`)).data.map((row: { id: number }) => row.id)).toContain(courseId);
  expect((await request(member, "/dashboard/stats")).data.totalCourses).toBe(statsBefore.data.totalCourses + 1);
  expect((await request(member, `/courses/${courseId}`)).data.lessons).toEqual([]);
  expect((await request(member, `/courses/${courseId}/lessons`)).data).toEqual([]);
  expect((await request(member, `/lessons/${lessonId}`)).status).toBe(404);
  expect((await request(member, `/enrollments/${courseId}/progress`, "PATCH", { lessonId })).status).toBe(400);
  expect((await request(member, "/enrollments", "POST", { courseId })).status).toBe(201);
  expect((await request(member, "/enrollments")).data.find((row: { courseId: number }) => row.courseId === courseId).totalLessons).toBe(0);

  const lessonRevision = await revision(owner, `/editorial/lessons/${lessonId}`);
  expect((await request(owner, `/lessons/${lessonId}/approve`, "POST", { revision: lessonRevision })).status).toBe(200);
  expect((await request(member, "/dashboard/stats")).data.totalLessons).toBe(statsBefore.data.totalLessons + 1);
  expect((await request(member, `/courses/${courseId}`)).data.lessons.map((row: { id: number }) => row.id)).toEqual([lessonId]);
  expect((await request(member, `/courses/${courseId}/lessons`)).data.map((row: { id: number }) => row.id)).toEqual([lessonId]);
  expect((await request(member, `/lessons/${lessonId}`)).status).toBe(200);
  expect((await request(member, `/enrollments/${courseId}/progress`, "PATCH", { lessonId })).status).toBe(200);

  // A published lesson must not remain readable or progressable when its course is withdrawn.
  expect((await request(editor, `/courses/${courseId}`, "PATCH", courseCopy("Withdrawn course"))).status).toBe(200);
  await assertCourseHidden(courseId, lessonId);
  expect((await request(member, `/enrollments/${courseId}/progress`, "PATCH", { lessonId })).status).toBe(403);
  expect((await request(member, "/dashboard/stats")).data.totalCourses).toBe(statsBefore.data.totalCourses);
  expect((await request(member, "/dashboard/stats")).data.totalLessons).toBe(statsBefore.data.totalLessons);
  expect((await request(owner, `/courses/${courseId}/approve`, "POST", { revision: courseRevision })).status).toBe(409);
  const latestCourseRevision = await revision(owner, `/editorial/courses/${courseId}`);
  expect((await request(owner, `/courses/${courseId}/approve`, "POST", { revision: latestCourseRevision })).status).toBe(200);
  expect((await request(member, `/lessons/${lessonId}`)).status).toBe(200);

  // Replacing published lesson copy removes it from all member surfaces immediately.
  expect((await request(editor, `/lessons/${lessonId}`, "PATCH", lessonCopy("Withdrawn lesson"))).status).toBe(200);
  expect((await request(member, `/courses/${courseId}`)).data.lessons).toEqual([]);
  expect((await request(member, `/courses/${courseId}/lessons`)).data).toEqual([]);
  expect((await request(member, `/lessons/${lessonId}`)).status).toBe(404);
  expect((await request(member, `/enrollments/${courseId}/progress`, "PATCH", { lessonId })).status).toBe(400);
  const enrollment = (await request(member, "/enrollments")).data.find((row: { courseId: number }) => row.courseId === courseId);
  expect(enrollment).toMatchObject({ totalLessons: 0, completedLessonIds: [] });
  expect((await request(member, "/dashboard/stats")).data.totalLessons).toBe(statsBefore.data.totalLessons);
  expect((await request(owner, `/lessons/${lessonId}/approve`, "POST", { revision: lessonRevision })).status).toBe(409);
  const latestLessonRevision = await revision(owner, `/editorial/lessons/${lessonId}`);
  expect((await request(owner, `/lessons/${lessonId}/approve`, "POST", { revision: latestLessonRevision })).status).toBe(200);
  expect((await request(member, `/lessons/${lessonId}`)).data.content).toBe("Withdrawn lesson");
});