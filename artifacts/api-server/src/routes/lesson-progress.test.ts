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
import { approvedTopicLessons } from "../lib/approved-topic-lessons";
import { requireDevelopmentDatabase } from "./test-development-database";

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
const blockedRetryId = `test-blocked-retry-${run}`;
const blockedRetryActor = `Test Blocked Retry ${run}`;
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
  requireDevelopmentDatabase();
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
    title: courseTitle, description: "Isolated progress fixture", categoryId: category.id,
    instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
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
    { clerkId: blockedRetryId, displayName: blockedRetryActor, email: `${blockedRetryId}@example.invalid`, membershipTier: "Elevated" },
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
      await db.delete(activityTable).where(and(eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, blockedRetryActor)));
    }
    if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, elevatedId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, freeId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, concurrentId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, retryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, blockedRetryId));
  } finally {
    await pool.end();
  }
});

test("failed activity insert rolls back enrollment; concurrent retries create one enrollment and activity", async () => {
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

  const retries = await Promise.all(
    Array.from({ length: 16 }, () => request(retryId, "/enrollments", "POST", { courseId })),
  );
  expect(retries.map(result => result.status)).toEqual(Array(16).fill(201));
  const ids = retries.map(result => (result.data as { id: number }).id);
  expect(new Set(ids).size).toBe(1);

  const rows = await db.select().from(enrollmentsTable)
    .where(and(eq(enrollmentsTable.userId, retryId), eq(enrollmentsTable.courseId, courseId)));
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(ids[0]);
  expect(((await request(retryId, "/enrollments")).data as Array<{ courseId: number }>).filter(
    (row: { courseId: number }) => row.courseId === courseId,
  )).toHaveLength(1);
  const activity = await db.select().from(activityTable).where(and(
    eq(activityTable.entityTitle, courseTitle),
    eq(activityTable.actorName, retryActor),
  ));
  expect(activity).toHaveLength(1);
  expect(activity[0].type).toBe("enrollment");
});

test("retries waiting on an open enrollment recover after its activity write fails", async () => {
  const failure = new Error("Injected delayed enrollment activity failure");
  const transaction = db.transaction.bind(db);
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
  let activityStarted!: () => void;
  const activityReached = new Promise<void>(resolve => { activityStarted = resolve; });
  let contendersStarted!: () => void;
  const contendersReached = new Promise<void>(resolve => { contendersStarted = resolve; });
  const contenderCount = 3;
  let transactions = 0;
  let waiting = 0;
  const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
    transaction(async tx => {
      if (transactions++ === 0) {
        const insert = tx.insert.bind(tx);
        vi.spyOn(tx, "insert").mockImplementation(((table: typeof activityTable) => {
          if (table === activityTable) return {
            values: async () => {
              activityStarted();
              await failureGate;
              throw failure;
            },
          };
          return insert(table);
        }) as typeof tx.insert);
      } else {
        // The callback starts the insert before yielding; these requests then
        // wait for the first transaction's uncommitted unique-index entry.
        const pending = callback(tx);
        if (++waiting === contenderCount) contendersStarted();
        return pending;
      }
      return callback(tx);
    }, config),
  );

  const requests: Array<Promise<Awaited<ReturnType<typeof request>>>> = [];
  try {
    const first = request(blockedRetryId, "/enrollments", "POST", { courseId });
    requests.push(first);
    await activityReached;
    const contenders = Array.from({ length: contenderCount }, () =>
      request(blockedRetryId, "/enrollments", "POST", { courseId }));
    requests.push(...contenders);
    await contendersReached;
    // None can respond while the first insert is still uncommitted.
    expect(await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, blockedRetryId), eq(enrollmentsTable.courseId, courseId),
    ))).toHaveLength(0);
    releaseFailure();

    expect((await first).status).toBe(500);
    expect(requestError).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, courseId, enrollmentId: expect.any(Number) }),
      "Enrollment activity write failed; rolling back enrollment",
    );
    const results = await Promise.all(contenders);
    expect(results.map(result => result.status)).toEqual(Array(contenderCount).fill(201));
    const ids = results.map(result => (result.data as { id: number }).id);
    expect(new Set(ids).size).toBe(1);

    const rows = await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, blockedRetryId), eq(enrollmentsTable.courseId, courseId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids[0]);
    const activity = await db.select().from(activityTable).where(and(
      eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, blockedRetryActor),
    ));
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe("enrollment");
  } finally {
    releaseFailure();
    await Promise.allSettled(requests);
    transactionSpy.mockRestore();
  }
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
  const userId = `test-reviewed-resume-${run}`;
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

test("standalone course resume hides published lessons that no longer match reviewed copy", async () => {
  const userId = `test-reviewed-resume-${run}`;
  const approved = approvedTopicLessons[0];
  let reviewedCourseId: number | undefined;
  try {
    await db.insert(usersTable).values({
      clerkId: userId, displayName: "Reviewed Resume Test",
      email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [course] = await db.insert(coursesTable).values({
      title: approved.title, description: "Reviewed resume fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
    }).returning();
    reviewedCourseId = course.id;
    const [visible, hidden] = await db.insert(lessonsTable).values([
      { courseId: course.id, title: approved.title, content: approved.content, sortOrder: 1, publishedAt: new Date() },
      { courseId: course.id, title: approved.title, content: "Unreviewed copy", sortOrder: 1, publishedAt: new Date() },
    ]).returning();
    const listing = await request(userId, `/courses/${course.id}/lessons`);
    expect(listing.status).toBe(200);
    expect((listing.data as Array<{ id: number }>).map(lesson => lesson.id)).toEqual([visible.id]);
    expect((await request(userId, `/lessons/${hidden.id}`)).status).toBe(404);

    const initial = await request(userId, "/enrollments", "POST", { courseId: course.id });
    expect(initial.status).toBe(201);
    await db.update(enrollmentsTable).set({ lastLessonId: hidden.id })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    const listed = await request(userId, "/enrollments");
    expect(listed.status).toBe(200);
    expect((listed.data as Array<{ courseId: number; lastLessonId: number | null }>)
      .find(row => row.courseId === course.id)?.lastLessonId).toBeNull();
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ lastLessonId: null });

    await db.update(enrollmentsTable).set({ lastLessonId: visible.id })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    const resumed = await request(userId, "/enrollments");
    expect((resumed.data as Array<{ courseId: number; lastLessonId: number | null }>)
      .find(row => row.courseId === course.id)?.lastLessonId).toBe(visible.id);
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ lastLessonId: visible.id });
  } finally {
    if (reviewedCourseId) {
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, reviewedCourseId));
      await db.delete(lessonsTable).where(eq(lessonsTable.courseId, reviewedCourseId));
      await db.delete(coursesTable).where(eq(coursesTable.id, reviewedCourseId));
    }
    await db.delete(activityTable).where(and(
      eq(activityTable.entityTitle, approved.title), eq(activityTable.actorName, "Reviewed Resume Test"),
    ));
    await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
  }
});

test("a draft exact duplicate before the published approved lesson cannot block opening or completing it", async () => {
  const userId = `test-approved-duplicate-${run}`;
  const approved = approvedTopicLessons[0];
  let reviewedCourseId: number | undefined;
  try {
    await db.insert(usersTable).values({
      clerkId: userId, displayName: "Approved Duplicate Test",
      email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [course] = await db.insert(coursesTable).values({
      title: approved.title, description: "Draft duplicate fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
    }).returning();
    reviewedCourseId = course.id;
    const [draft] = await db.insert(lessonsTable).values({
      courseId: course.id, title: approved.title, content: approved.content,
      sortOrder: 1, publishedAt: null,
    }).returning();
    const [published] = await db.insert(lessonsTable).values({
      courseId: course.id, title: approved.title, content: approved.content,
      sortOrder: 1, publishedAt: new Date(),
    }).returning();
    expect(draft.id).toBeLessThan(published.id);

    const listing = await request(userId, `/courses/${course.id}/lessons`);
    expect(listing.status).toBe(200);
    expect((listing.data as Array<{ id: number }>).map(lesson => lesson.id)).toEqual([published.id]);
    expect((await request(userId, `/lessons/${draft.id}`)).status).toBe(404);
    const detail = await request(userId, `/lessons/${published.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({ id: published.id });

    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).status).toBe(201);
    expect((await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: draft.id })).status).toBe(400);
    const completion = await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: published.id });
    expect(completion.status).toBe(200);
    expect(completion.data).toMatchObject({ lastLessonId: published.id, completedLessons: 1 });
    const progress = await request(userId, "/enrollments");
    expect(progress.status).toBe(200);
    expect((progress.data as Array<{ courseId: number; completedLessonIds: number[] }>)
      .find(row => row.courseId === course.id)?.completedLessonIds).toEqual([published.id]);
  } finally {
    if (reviewedCourseId) {
      await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, userId));
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, reviewedCourseId));
      await db.delete(lessonsTable).where(eq(lessonsTable.courseId, reviewedCourseId));
      await db.delete(coursesTable).where(eq(coursesTable.id, reviewedCourseId));
    }
    await db.delete(activityTable).where(and(
      eq(activityTable.entityTitle, approved.title), eq(activityTable.actorName, "Approved Duplicate Test"),
    ));
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
