import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, pool, activityTable, categoriesTable, coursesTable, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, usersTable,
} from "@workspace/db";

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
  }).returning();
  courseId = course.id;
  const lessons = await db.insert(lessonsTable).values(
    [1, 2, 3, 4].map(sortOrder => ({
      courseId, title: `Module ${sortOrder}`, content: `Private module ${sortOrder}`,
      sortOrder,
    })),
  ).returning();
  lessonIds = lessons.map(lesson => lesson.id);
  await db.insert(usersTable).values([
    { clerkId: elevatedId, displayName: "Test Elevated", email: `${elevatedId}@example.invalid`, membershipTier: "Elevated" },
    { clerkId: freeId, displayName: "Test Free", email: `${freeId}@example.invalid`, membershipTier: "Free" },
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
  }
  if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
  await db.delete(usersTable).where(eq(usersTable.clerkId, elevatedId));
  await db.delete(usersTable).where(eq(usersTable.clerkId, freeId));
  await pool.end();
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