import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, pool, activityTable, categoriesTable, coursesTable, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, usersTable,
} from "@workspace/db";
import { ensureEnrollmentSchema } from "../lib/ensure-enrollment-schema";

// Only this isolated test router trusts the test identity header. The real
// application and its Clerk middleware are never started by this suite.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = req.header("x-test-user");
    next();
  },
  jitProvisionUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const run = randomUUID();
const elevatedId = `test-elevated-${run}`;
const freeId = `test-free-${run}`;
const concurrentId = `test-concurrent-${run}`;
let courseId: number;
let categoryId: number;
let lessonIds: number[];
let server: Server;
let baseUrl: string;

async function request(user: string, path: string, method = "GET", body?: object) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "x-test-user": user, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

async function enrollment(user: string) {
  const result = await request(user, "/enrollments");
  expect(result.status).toBe(200);
  return (result.data as Array<{
    courseId: number; completedLessons: number; completedLessonIds: number[];
    totalLessons: number; lastLessonId: number | null;
  }>).find(row => row.courseId === courseId);
}

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Progress integration tests must only run against a development database");
  }
  await ensureEnrollmentSchema();
  // Use the same routes and database as the app, but a private HTTP server and
  // disposable fixtures. A new request reads from the DB, as after a reload.
  const { default: coursesRouter } = await import("./courses");
  const { default: enrollmentsRouter } = await import("./enrollments");
  const app = express();
  app.use(express.json(), coursesRouter, enrollmentsRouter);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [category] = await db.insert(categoriesTable).values({
    name: `Progress test ${run}`, slug: `progress-test-${run}`,
  }).returning();
  categoryId = category.id;
  const [course] = await db.insert(coursesTable).values({
    title: `Accelerator progress test ${run}`, description: "Isolated progress fixture",
    categoryId: category.id, instructorName: "Test", accessTier: "Elevated",
    publishedAt: new Date(),
  }).returning();
  courseId = course.id;
  const lessons = await db.insert(lessonsTable).values(
    [1, 2, 3, 4].map(sortOrder => ({
      courseId, title: `Module ${sortOrder}`, content: `Private module ${sortOrder}`,
      sortOrder, publishedAt: new Date(),
    })),
  ).returning();
  lessonIds = lessons.map(lesson => lesson.id);
  await db.insert(usersTable).values([
    { clerkId: elevatedId, displayName: "Test Elevated", email: `${elevatedId}@example.invalid`, membershipTier: "Elevated" },
    { clerkId: freeId, displayName: "Test Free", email: `${freeId}@example.invalid`, membershipTier: "Free" },
    { clerkId: concurrentId, displayName: "Test Concurrent", email: `${concurrentId}@example.invalid`, membershipTier: "Elevated" },
  ]);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Remove only rows belonging to this run, even when an assertion failed.
  if (courseId) {
    await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, elevatedId));
    await db.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, courseId));
    await db.delete(lessonsTable).where(eq(lessonsTable.courseId, courseId));
    await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
    await db.delete(activityTable).where(and(eq(activityTable.entityTitle, `Accelerator progress test ${run}`), eq(activityTable.actorName, "Test Elevated")));
    await db.delete(activityTable).where(and(eq(activityTable.entityTitle, `Accelerator progress test ${run}`), eq(activityTable.actorName, "Test Concurrent")));
  }
  if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
  await db.delete(usersTable).where(eq(usersTable.clerkId, elevatedId));
  await db.delete(usersTable).where(eq(usersTable.clerkId, freeId));
  await db.delete(usersTable).where(eq(usersTable.clerkId, concurrentId));
  await pool.end();
});

test("simultaneous enrollment requests return one row and create one activity entry", async () => {
  const results = await Promise.all(
    Array.from({ length: 16 }, () => request(concurrentId, "/enrollments", "POST", { courseId })),
  );
  expect(results.map(result => result.status)).toEqual(Array(16).fill(201));
  const ids = results.map(result => (result.data as { id: number }).id);
  expect(new Set(ids).size).toBe(1);

  const rows = await db.select().from(enrollmentsTable)
    .where(and(eq(enrollmentsTable.userId, concurrentId), eq(enrollmentsTable.courseId, courseId)));
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(ids[0]);
  expect(((await request(concurrentId, "/enrollments")).data as Array<{ courseId: number }>).filter(
    (row: { courseId: number }) => row.courseId === courseId,
  )).toHaveLength(1);
  const activity = await db.select().from(activityTable).where(and(
    eq(activityTable.entityTitle, `Accelerator progress test ${run}`),
    eq(activityTable.actorName, "Test Concurrent"),
  ));
  expect(activity).toHaveLength(1);

  // Even a direct insert outside the HTTP handler cannot bypass uniqueness.
  await expect(db.insert(enrollmentsTable).values({ userId: concurrentId, courseId }))
    .rejects.toMatchObject({ cause: { code: "23505" } });
  const repeated = await request(concurrentId, "/enrollments", "POST", { courseId });
  expect(repeated.status).toBe(201);
  expect((repeated.data as { id: number }).id).toBe(ids[0]);
});

test("Elevated progress survives fresh requests and revisit; repeats and out-of-order completions do not inflate it", async () => {
  const enrolled = await request(elevatedId, "/enrollments", "POST", { courseId });
  expect(enrolled.status).toBe(201);
  expect(await enrollment(elevatedId)).toMatchObject({ completedLessons: 0, completedLessonIds: [], totalLessons: 4 });

  const order = [lessonIds[2], lessonIds[0], lessonIds[2], lessonIds[3], lessonIds[1], lessonIds[0]];
  const counts = [1, 2, 2, 3, 4, 4];
  for (const [index, lessonId] of order.entries()) {
    const result = await request(elevatedId, `/enrollments/${courseId}/progress`, "PATCH", { lessonId });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ completedLessons: counts[index], totalLessons: 4 });
    expect(await enrollment(elevatedId)).toMatchObject({
      completedLessons: counts[index],
      completedLessonIds: [...new Set(order.slice(0, index + 1))].sort((a, b) => a - b),
      lastLessonId: lessonId,
    });
  }
  // Re-enrollment and a later fresh read must preserve the four completions.
  expect((await request(elevatedId, "/enrollments", "POST", { courseId })).status).toBe(201);
  expect(await enrollment(elevatedId)).toMatchObject({
    completedLessons: 4, totalLessons: 4, completedLessonIds: [...lessonIds].sort((a, b) => a - b),
  });
  expect((await request(elevatedId, `/lessons/${lessonIds[0]}`)).status).toBe(200);
  expect((await request(elevatedId, `/courses/${courseId}/lessons`)).status).toBe(200);
  expect(await enrollment(elevatedId)).toMatchObject({ completedLessons: 4, totalLessons: 4 });
});

test("Free member cannot read, enroll in, or complete Elevated lessons", async () => {
  expect((await request(freeId, `/lessons/${lessonIds[0]}`)).status).toBe(403);
  expect((await request(freeId, `/courses/${courseId}/lessons`)).status).toBe(403);
  expect((await request(freeId, "/enrollments", "POST", { courseId })).status).toBe(403);
  expect((await request(freeId, `/enrollments/${courseId}/progress`, "PATCH", { lessonId: lessonIds[0] })).status).toBe(403);
  expect(await enrollment(freeId)).toBeUndefined();
});
