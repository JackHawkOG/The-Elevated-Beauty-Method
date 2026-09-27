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
const retryId = `test-retry-${run}`;
const retryActor = `Test Retry ${run}`;
const courseTitle = `Accelerator progress test ${run}`;
const requestError = vi.fn();
let courseId: number;
let categoryId: number;
let lessonIds: number[];
let server: Server;
let baseUrl: string;

let fixturesStarted = false;

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
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT || !process.env.DATABASE_URL) {
    throw new Error("Progress integration tests require a development database and cannot run in a deployment");
  }
  // Replit supplies PG* and DATABASE_URL for the same development database.
  // Reject a manually overridden DATABASE_URL before any schema changes or inserts.
  const target = new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGPORT || !process.env.PGDATABASE ||
      target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE) {
    throw new Error("Progress tests require the workspace development database URL");
  }
  fixturesStarted = true;
  await ensureEnrollmentSchema();
  const { default: coursesRouter } = await import("./courses");
  const { default: enrollmentsRouter } = await import("./enrollments");
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error: requestError } as unknown as typeof req.log;
    next();
  });
  app.use(express.json(), coursesRouter, enrollmentsRouter);
  app.use(((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  }) as express.ErrorRequestHandler);
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
    title: courseTitle, description: "Isolated progress fixture",
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
    { clerkId: retryId, displayName: retryActor, email: `${retryId}@example.invalid`, membershipTier: "Elevated" },
  ]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Remove only rows belonging to this run, even when setup or an assertion failed.
    if (!fixturesStarted) return;
    if (courseId) {
      await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, elevatedId));
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, courseId));
      await db.delete(lessonsTable).where(eq(lessonsTable.courseId, courseId));
      await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
      await db.delete(activityTable).where(and(eq(activityTable.entityTitle, `Accelerator progress test ${run}`), eq(activityTable.actorName, "Test Elevated")));
      await db.delete(activityTable).where(and(eq(activityTable.entityTitle, `Accelerator progress test ${run}`), eq(activityTable.actorName, "Test Concurrent")));
      await db.delete(activityTable).where(and(eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, retryActor)));
    }
    if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, elevatedId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, freeId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, concurrentId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, retryId));
  } finally {
    await pool.end();
  }
});

test("failed activity insert rolls back enrollment; retry creates one enrollment and activity", async () => {
  const failure = new Error("Injected enrollment activity failure");
  const transaction = db.transaction.bind(db);
  const transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) =>
    transaction(async tx => {
      const insert = tx.insert.bind(tx);
      vi.spyOn(tx, "insert").mockImplementation(((table: typeof activityTable) => {
        if (table === activityTable) return { values: () => Promise.reject(failure) };
        return insert(table);
      }) as typeof tx.insert);
      return callback(tx);
    }, config),
  );

  try {
    expect((await request(retryId, "/enrollments", "POST", { courseId })).status).toBe(500);
    expect(requestError).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, courseId, enrollmentId: expect.any(Number) }),
      "Enrollment activity write failed; rolling back enrollment",
    );
    expect(await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, retryId), eq(enrollmentsTable.courseId, courseId),
    ))).toHaveLength(0);
    expect(await db.select().from(activityTable).where(and(
      eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, retryActor),
    ))).toHaveLength(0);
  } finally {
    transactionSpy.mockRestore();
  }

  expect((await request(retryId, "/enrollments", "POST", { courseId })).status).toBe(201);
  expect(await db.select().from(enrollmentsTable).where(and(
    eq(enrollmentsTable.userId, retryId), eq(enrollmentsTable.courseId, courseId),
  ))).toHaveLength(1);
  expect(await db.select().from(activityTable).where(and(
    eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, retryActor),
  ))).toHaveLength(1);
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

test("resume never exposes a missing, unpublished, or other-course lesson", async () => {
  const userId = `test-resume-${run}`;
  let otherCourseId: number | undefined;
  try {
    await db.insert(usersTable).values({
      clerkId: userId, displayName: "Resume Test", email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [otherCourse] = await db.insert(coursesTable).values({
      title: `Resume pointer test ${run}`, description: "Cross-course pointer fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
    }).returning();
    otherCourseId = otherCourse.id;
    const [otherLesson] = await db.insert(lessonsTable).values({
      courseId: otherCourse.id, title: "Other lesson", sortOrder: 1, publishedAt: new Date(),
    }).returning();
    const [draftLesson] = await db.insert(lessonsTable).values({
      courseId, title: "Unpublished resume test", sortOrder: 5, publishedAt: null,
    }).returning();
    try {
      expect((await request(userId, "/enrollments", "POST", { courseId })).status).toBe(201);
      const assertResume = async (pointer: number, expected: number | null) => {
        await db.update(enrollmentsTable).set({ lastLessonId: pointer })
          .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)));
        expect(await enrollment(userId)).toMatchObject({ lastLessonId: expected });
        const again = await request(userId, "/enrollments", "POST", { courseId });
        expect(again.status).toBe(201);
        expect(again.data).toMatchObject({ lastLessonId: expected });
      };
      await assertResume(otherLesson.id, null);
      await assertResume(draftLesson.id, null);
      await assertResume(2147483647, null);
      await assertResume(lessonIds[0], lessonIds[0]);
    } finally {
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.userId, userId));
      await db.delete(lessonsTable).where(eq(lessonsTable.id, draftLesson.id));
    }
  } finally {
    if (otherCourseId) {
      await db.delete(lessonsTable).where(eq(lessonsTable.courseId, otherCourseId));
      await db.delete(coursesTable).where(eq(coursesTable.id, otherCourseId));
    }
    await db.delete(activityTable).where(and(eq(activityTable.entityTitle, `Accelerator progress test ${run}`), eq(activityTable.actorName, "Resume Test")));
    await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
  }
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
