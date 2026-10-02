import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, activityTable, categoriesTable, coursesTable, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, usersTable,
} from "@workspace/db";
import { ensureEnrollmentSchema } from "../lib/ensure-enrollment-schema";
import { ensureAnnouncementSchema } from "../lib/ensure-announcement-schema";
import { approvedTopicLessons, publishedLessonsForCourse } from "../lib/approved-topic-lessons";
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

// Editorial requests stay inside the isolated router, with no live Clerk calls.
vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: { role: "editor" } }) } },
}));

const run = randomUUID();
const elevatedId = `test-elevated-${run}`;
const freeId = `test-free-${run}`;
const concurrentId = `test-concurrent-${run}`;
const retryId = `test-retry-${run}`;
const retryActor = `Test Retry ${run}`;
const blockedRetryId = `test-blocked-retry-${run}`;
const blockedRetryActor = `Test Blocked Retry ${run}`;
const waitingSuccessId = `test-waiting-success-${run}`;
const waitingSuccessActor = `Test Waiting Success ${run}`;
const courseTitle = `Accelerator progress test ${run}`;
const requestError = vi.fn();
const droppedReplyStatuses: number[] = [];
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
  await ensureAnnouncementSchema();
  const { default: coursesRouter } = await import("./courses");
  const { default: enrollmentsRouter } = await import("./enrollments");
  const { default: dashboardRouter } = await import("./dashboard");
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error: requestError } as unknown as typeof req.log;
    next();
  });
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/enrollments" && req.header("x-test-drop-enrollment-reply") === run) {
      // The route calls json only after its enrollment/activity transaction commits.
      res.json = ((_body: unknown) => {
        droppedReplyStatuses.push(res.statusCode);
        res.destroy();
        return res;
      }) as typeof res.json;
    }
    next();
  });
  app.use(express.json(), coursesRouter, enrollmentsRouter, dashboardRouter);
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
    { clerkId: waitingSuccessId, displayName: waitingSuccessActor, email: `${waitingSuccessId}@example.invalid`, membershipTier: "Elevated" },
  ]);
}, 30000);

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
      await db.delete(activityTable).where(and(eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, waitingSuccessActor)));
    }
    if (categoryId) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, elevatedId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, freeId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, concurrentId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, retryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, blockedRetryId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, waitingSuccessId));
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

test("retries waiting on a successful enrollment do not duplicate its activity", async () => {
  const transaction = db.transaction.bind(db);
  let releaseActivity!: () => void;
  const activityGate = new Promise<void>(resolve => { releaseActivity = resolve; });
  let activityStarted!: () => void;
  const activityReached = new Promise<void>(resolve => { activityStarted = resolve; });
  let contendersStarted!: () => void;
  const contendersReached = new Promise<void>(resolve => { contendersStarted = resolve; });
  const contenderCount = 3;
  let transactions = 0;
  let insertAttempts = 0;
  const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
    transaction(async tx => {
      const insert = tx.insert.bind(tx);
      if (transactions++ === 0) {
        vi.spyOn(tx, "insert").mockImplementation(((table: typeof activityTable) => {
          if (table === activityTable) return {
            values: async (values: typeof activityTable.$inferInsert) => {
              activityStarted();
              await activityGate;
              return insert(activityTable).values(values);
            },
          };
          return insert(table);
        }) as typeof tx.insert);
      } else {
        vi.spyOn(tx, "insert").mockImplementation(((table: typeof enrollmentsTable) => {
          if (table === enrollmentsTable && ++insertAttempts === contenderCount) contendersStarted();
          return insert(table);
        }) as typeof tx.insert);
      }
      return callback(tx);
    }, config),
  );

  const requests: Array<Promise<Awaited<ReturnType<typeof request>>>> = [];
  try {
    const first = request(waitingSuccessId, "/enrollments", "POST", { courseId });
    requests.push(first);
    await activityReached;
    const contenders = Array.from({ length: contenderCount }, () =>
      request(waitingSuccessId, "/enrollments", "POST", { courseId }));
    requests.push(...contenders);
    await contendersReached;
    // The winning enrollment is not visible until its activity also commits.
    expect(await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, waitingSuccessId), eq(enrollmentsTable.courseId, courseId),
    ))).toHaveLength(0);
    releaseActivity();

    const results = await Promise.all(requests);
    expect(results.map(result => result.status)).toEqual(Array(contenderCount + 1).fill(201));
    const ids = results.map(result => (result.data as { id: number }).id);
    expect(new Set(ids).size).toBe(1);
    const rows = await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, waitingSuccessId), eq(enrollmentsTable.courseId, courseId),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids[0]);
    const activity = await db.select().from(activityTable).where(and(
      eq(activityTable.entityTitle, courseTitle), eq(activityTable.actorName, waitingSuccessActor),
    ));
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe("enrollment");
  } finally {
    releaseActivity();
    await Promise.allSettled(requests);
    transactionSpy.mockRestore();
  }
});

test("a retry after a committed enrollment's HTTP reply is lost reuses its feed activity", async () => {
  const userId = `test-lost-reply-${run}`;
  const actorName = `Test Lost Reply ${run}`;
  const title = `Lost reply course ${run}`;
  let lostReplyCourseId: number | undefined;
  try {
    await db.insert(usersTable).values({
      clerkId: userId, displayName: actorName,
      email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [course] = await db.insert(coursesTable).values({
      title, description: "Lost enrollment reply fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
    }).returning();
    lostReplyCourseId = course.id;

    await expect(fetch(`${baseUrl}/enrollments`, {
      method: "POST",
      headers: {
        "x-test-user": userId,
        "x-test-drop-enrollment-reply": run,
        "content-type": "application/json",
      },
      body: JSON.stringify({ courseId: course.id }),
    })).rejects.toThrow();
    expect(droppedReplyStatuses).toEqual([201]);

    const persisted = await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id),
    ));
    expect(persisted).toHaveLength(1);
    const retry = await request(userId, "/enrollments", "POST", { courseId: course.id });
    expect(retry.status).toBe(201);
    expect((retry.data as { id: number }).id).toBe(persisted[0].id);
    expect(await db.select().from(enrollmentsTable).where(and(
      eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id),
    ))).toHaveLength(1);
    const activity = await db.select().from(activityTable).where(and(
      eq(activityTable.type, "enrollment"),
      eq(activityTable.entityTitle, title),
      eq(activityTable.actorName, actorName),
    ));
    expect(activity).toHaveLength(1);
  } finally {
    if (lostReplyCourseId) {
      await db.delete(enrollmentsTable).where(and(
        eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, lostReplyCourseId),
      ));
      await db.delete(activityTable).where(and(
        eq(activityTable.type, "enrollment"),
        eq(activityTable.entityTitle, title),
        eq(activityTable.actorName, actorName),
      ));
      await db.delete(coursesTable).where(eq(coursesTable.id, lostReplyCourseId));
    }
    await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
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
    const statsBefore = await request(userId, "/dashboard/stats");
    expect(statsBefore.status).toBe(200);
    const ordinaryLessonTotal = (statsBefore.data as { totalLessons: number }).totalLessons;
    await db.insert(usersTable).values({
      clerkId: userId, displayName: "Reviewed Resume Test",
      email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [course] = await db.insert(coursesTable).values({
      title: approved.title, description: "Reviewed resume fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", isFeatured: true, publishedAt: new Date(),
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
    const courseDetail = await request(userId, `/courses/${course.id}`);
    expect(courseDetail.status).toBe(200);
    expect(courseDetail.data).toMatchObject({ lessonCount: 1 });
    const courseList = await request(userId, "/courses");
    expect(courseList.status).toBe(200);
    expect((courseList.data as Array<{ id: number; lessonCount: number }>)
      .find(row => row.id === course.id)?.lessonCount).toBe(1);
    const featured = await request(userId, "/dashboard/featured");
    expect(featured.status).toBe(200);
    expect((featured.data as Array<{ id: number; lessonCount: number }>)
      .find(row => row.id === course.id)?.lessonCount).toBe(1);
    const statsWithReviewedLesson = await request(userId, "/dashboard/stats");
    expect(statsWithReviewedLesson.status).toBe(200);
    expect(statsWithReviewedLesson.data).toMatchObject({ totalLessons: ordinaryLessonTotal + 1 });
    const initial = await request(userId, "/enrollments", "POST", { courseId: course.id });
    expect(initial.status).toBe(201);
    expect(initial.data).toMatchObject({ totalLessons: 1, completedLessons: 0 });
    // A completion from before editorial review is retained in storage, but
    // never contributes to visible progress.
    await db.insert(lessonCompletionsTable).values({ userId, lessonId: hidden.id });
    await db.update(enrollmentsTable).set({ completedLessons: 1 })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    await db.update(enrollmentsTable).set({ lastLessonId: hidden.id })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    const listed = await request(userId, "/enrollments");
    expect(listed.status).toBe(200);
    expect((listed.data as Array<{ courseId: number }>)
      .find(row => row.courseId === course.id)).toMatchObject({
        lastLessonId: null, totalLessons: 1, completedLessons: 0, completedLessonIds: [],
      });
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ lastLessonId: null, totalLessons: 1, completedLessons: 0 });
    expect((await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: hidden.id })).status)
      .toBe(404);
    const progress = await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: visible.id });
    expect(progress.status).toBe(200);
    expect(progress.data).toMatchObject({ totalLessons: 1, completedLessons: 1 });
    expect(((await request(userId, "/enrollments")).data as Array<{ courseId: number }>)
      .find(row => row.courseId === course.id))
      .toMatchObject({ totalLessons: 1, completedLessons: 1, completedLessonIds: [visible.id] });

    await db.update(enrollmentsTable).set({ lastLessonId: visible.id })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    const resumed = await request(userId, "/enrollments");
    expect((resumed.data as Array<{ courseId: number; lastLessonId: number | null }>)
      .find(row => row.courseId === course.id)?.lastLessonId).toBe(visible.id);
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ lastLessonId: visible.id, totalLessons: 1, completedLessons: 1 });

    await db.update(lessonsTable).set({ content: "Changed after approval" }).where(eq(lessonsTable.id, visible.id));
    expect((await request(userId, `/courses/${course.id}`)).data).toMatchObject({ lessonCount: 0 });
    const emptyList = await request(userId, "/courses");
    expect((emptyList.data as Array<{ id: number; lessonCount: number }>)
      .find(row => row.id === course.id)?.lessonCount).toBe(0);
    const emptyFeatured = await request(userId, "/dashboard/featured");
    expect((emptyFeatured.data as Array<{ id: number; lessonCount: number }>)
      .find(row => row.id === course.id)?.lessonCount).toBe(0);
    const statsWithoutReviewedLesson = await request(userId, "/dashboard/stats");
    expect(statsWithoutReviewedLesson.status).toBe(200);
    expect(statsWithoutReviewedLesson.data).toMatchObject({ totalLessons: ordinaryLessonTotal });
    expect(((await request(userId, "/enrollments")).data as Array<{ courseId: number }>)
      .find(row => row.courseId === course.id))
      .toMatchObject({ totalLessons: 0, completedLessons: 0, completedLessonIds: [], lastLessonId: null });
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ totalLessons: 0, completedLessons: 0, lastLessonId: null });
  } finally {
    if (reviewedCourseId) {
      await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, userId));
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
    const statsBefore = await request(userId, "/dashboard/stats");
    expect(statsBefore.status).toBe(200);
    const priorTotal = (statsBefore.data as { totalLessons: number }).totalLessons;
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
    expect((await request(userId, "/dashboard/stats")).data).toMatchObject({ totalLessons: priorTotal });
    const [published] = await db.insert(lessonsTable).values({
      courseId: course.id, title: approved.title, content: approved.content,
      sortOrder: 1, publishedAt: new Date(),
    }).returning();
    expect(draft.id).toBeLessThan(published.id);
    expect((await request(userId, "/dashboard/stats")).data).toMatchObject({ totalLessons: priorTotal + 1 });

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

test("two published approved copies select the lowest ID and switch without inherited progress when it is unpublished", async () => {
  const userId = `test-approved-published-tie-${run}`;
  const actorName = "Approved Published Tie Test";
  const approved = approvedTopicLessons[0];
  let reviewedCourseId: number | undefined;
  try {
    const statsBefore = await request(userId, "/dashboard/stats");
    expect(statsBefore.status).toBe(200);
    const priorTotal = (statsBefore.data as { totalLessons: number }).totalLessons;
    await db.insert(usersTable).values({
      clerkId: userId, displayName: actorName,
      email: `${userId}@example.invalid`, membershipTier: "Elevated",
    });
    const [course] = await db.insert(coursesTable).values({
      title: approved.title, description: "Published tie fixture", categoryId,
      instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
    }).returning();
    reviewedCourseId = course.id;
    const [selected, duplicate] = await db.insert(lessonsTable).values([
      { courseId: course.id, title: approved.title, content: approved.content, sortOrder: 1, publishedAt: new Date() },
      { courseId: course.id, title: approved.title, content: approved.content, sortOrder: 1, publishedAt: new Date() },
    ]).returning();
    expect(selected.id).toBeLessThan(duplicate.id);
    expect((await request(userId, "/dashboard/stats")).data).toMatchObject({ totalLessons: priorTotal + 1 });
    // A tied SQL query may return either order; selection must not depend on it.
    expect(publishedLessonsForCourse(course.title, [duplicate, selected]).map(lesson => lesson.id))
      .toEqual([selected.id]);

    for (let attempt = 0; attempt < 3; attempt++) {
      const courseDetail = await request(userId, `/courses/${course.id}`);
      expect(courseDetail.status).toBe(200);
      expect((courseDetail.data as { lessons: Array<{ id: number }> }).lessons.map(lesson => lesson.id)).toEqual([selected.id]);
      const listing = await request(userId, `/courses/${course.id}/lessons`);
      expect(listing.status).toBe(200);
      expect((listing.data as Array<{ id: number }>).map(lesson => lesson.id)).toEqual([selected.id]);
      expect((await request(userId, `/lessons/${selected.id}`)).status).toBe(200);
      expect((await request(userId, `/lessons/${duplicate.id}`)).status).toBe(404);
    }

    const initial = await request(userId, "/enrollments", "POST", { courseId: course.id });
    expect(initial.status).toBe(201);
    expect(initial.data).toMatchObject({ totalLessons: 1, completedLessons: 0 });
    await db.update(enrollmentsTable).set({ lastLessonId: duplicate.id })
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, course.id)));
    const hiddenResume = await request(userId, "/enrollments");
    expect((hiddenResume.data as Array<{ courseId: number; lastLessonId: number | null }>)
      .find(row => row.courseId === course.id)?.lastLessonId).toBeNull();
    expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
      .toMatchObject({ lastLessonId: null, totalLessons: 1 });
    expect((await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: duplicate.id })).status).toBe(404);

    const completion = await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: selected.id });
    expect(completion.status).toBe(200);
    expect(completion.data).toMatchObject({ lastLessonId: selected.id, totalLessons: 1, completedLessons: 1 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const resumed = await request(userId, "/enrollments");
      expect(resumed.status).toBe(200);
      expect((resumed.data as Array<{ courseId: number }>).find(row => row.courseId === course.id))
        .toMatchObject({ lastLessonId: selected.id, totalLessons: 1, completedLessons: 1, completedLessonIds: [selected.id] });
      expect((await request(userId, "/enrollments", "POST", { courseId: course.id })).data)
        .toMatchObject({ lastLessonId: selected.id, totalLessons: 1, completedLessons: 1 });
    }

    // Editorial unpublication leaves the approved content and historical
    // completion intact. Only publication changes; the other exact copy wins.
    await db.update(lessonsTable).set({ publishedAt: null }).where(eq(lessonsTable.id, selected.id));
    for (let attempt = 0; attempt < 3; attempt++) {
      const courseDetail = await request(userId, `/courses/${course.id}`);
      expect(courseDetail.status).toBe(200);
      expect(courseDetail.data).toMatchObject({ lessonCount: 1 });
      expect((courseDetail.data as { lessons: Array<{ id: number }> }).lessons.map(lesson => lesson.id))
        .toEqual([duplicate.id]);
      const listing = await request(userId, `/courses/${course.id}/lessons`);
      expect(listing.status).toBe(200);
      expect((listing.data as Array<{ id: number }>).map(lesson => lesson.id)).toEqual([duplicate.id]);
      const direct = await request(userId, `/lessons/${duplicate.id}`);
      expect(direct.status).toBe(200);
      expect(direct.data).toMatchObject({ id: duplicate.id, content: approved.content });
      expect((await request(userId, `/lessons/${selected.id}`)).status).toBe(404);

      const resumed = await request(userId, "/enrollments");
      expect(resumed.status).toBe(200);
      expect((resumed.data as Array<{ courseId: number }>).find(row => row.courseId === course.id))
        .toMatchObject({ lastLessonId: null, totalLessons: 1, completedLessons: 0, completedLessonIds: [] });
      const reenrolled = await request(userId, "/enrollments", "POST", { courseId: course.id });
      expect(reenrolled.status).toBe(201);
      expect(reenrolled.data).toMatchObject({ lastLessonId: null, totalLessons: 1, completedLessons: 0 });
    }
    expect((await request(userId, "/dashboard/stats")).data).toMatchObject({ totalLessons: priorTotal + 1 });
    expect((await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: selected.id })).status)
      .toBe(400);
    // Hiding a historical completion must not erase it or transfer it to the
    // replacement. The replacement gets credit only after its own completion.
    expect((await db.select().from(lessonCompletionsTable)
      .where(eq(lessonCompletionsTable.userId, userId))).map(row => row.lessonId)).toEqual([selected.id]);
    const replacementCompletion = await request(userId, `/enrollments/${course.id}/progress`, "PATCH", { lessonId: duplicate.id });
    expect(replacementCompletion.status).toBe(200);
    expect(replacementCompletion.data).toMatchObject({ lastLessonId: duplicate.id, totalLessons: 1, completedLessons: 1 });
    const replacementResume = await request(userId, "/enrollments");
    expect(replacementResume.status).toBe(200);
    expect((replacementResume.data as Array<{ courseId: number }>).find(row => row.courseId === course.id))
      .toMatchObject({ lastLessonId: duplicate.id, totalLessons: 1, completedLessons: 1, completedLessonIds: [duplicate.id] });
    const replacementReenrollment = await request(userId, "/enrollments", "POST", { courseId: course.id });
    expect(replacementReenrollment.status).toBe(201);
    expect(replacementReenrollment.data).toMatchObject({ lastLessonId: duplicate.id, totalLessons: 1, completedLessons: 1 });
    expect((await db.select().from(lessonCompletionsTable)
      .where(eq(lessonCompletionsTable.userId, userId))).map(row => row.lessonId).sort((a, b) => a - b))
      .toEqual([selected.id, duplicate.id]);
  } finally {
    if (reviewedCourseId) {
      await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, userId));
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.courseId, reviewedCourseId));
      await db.delete(lessonsTable).where(eq(lessonsTable.courseId, reviewedCourseId));
      await db.delete(coursesTable).where(eq(coursesTable.id, reviewedCourseId));
    }
    await db.delete(activityTable).where(and(
      eq(activityTable.entityTitle, approved.title), eq(activityTable.actorName, actorName),
    ));
    await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
  }
});

test.each(["success", "cleanup failure", "failure after cleanup"] as const)(
  "returning a lesson to draft clears only its course's resume pointers: %s",
  async outcome => {
    const fixtureCourses: number[] = [];
    let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const courses = await db.insert(coursesTable).values([1, 2].map(index => ({
        title: `Editorial resume ${index} ${run}`, description: "Isolated editorial fixture",
        categoryId, instructorName: "Test", accessTier: "Elevated", publishedAt: new Date(),
      }))).returning();
      fixtureCourses.push(...courses.map(course => course.id));
      const [target, sibling, other] = await db.insert(lessonsTable).values([
        { courseId: courses[0].id, title: "Published target", content: "Original copy", sortOrder: 1, publishedAt: new Date() },
        { courseId: courses[0].id, title: "Published sibling", sortOrder: 2, publishedAt: new Date() },
        { courseId: courses[1].id, title: "Other course lesson", sortOrder: 1, publishedAt: new Date() },
      ]).returning();
      const members = [1, 2, 3, 4].map(index => `test-editorial-${run}-${index}`);
      await db.insert(enrollmentsTable).values([
        { userId: members[0], courseId: target.courseId, lastLessonId: target.id, completedLessons: 2 },
        { userId: members[1], courseId: target.courseId, lastLessonId: target.id, completedLessons: 1 },
        { userId: members[2], courseId: target.courseId, lastLessonId: sibling.id, completedLessons: 1 },
        { userId: members[3], courseId: target.courseId, lastLessonId: null, completedLessons: 0 },
        { userId: members[0], courseId: other.courseId, lastLessonId: other.id, completedLessons: 1 },
        // Even a preexisting invalid pointer in another course is outside this edit.
        { userId: members[1], courseId: other.courseId, lastLessonId: target.id, completedLessons: 0 },
      ]);
      await db.insert(lessonCompletionsTable).values([
        { userId: members[0], lessonId: target.id },
        { userId: members[0], lessonId: sibling.id },
        { userId: members[1], lessonId: target.id },
        { userId: members[2], lessonId: sibling.id },
        { userId: members[0], lessonId: other.id },
      ]);
      const readEnrollments = () => db.select().from(enrollmentsTable)
        .where(inArray(enrollmentsTable.courseId, fixtureCourses)).orderBy(enrollmentsTable.id);
      const readCompletions = () => db.select().from(lessonCompletionsTable)
        .where(inArray(lessonCompletionsTable.lessonId, [target.id, sibling.id, other.id]))
        .orderBy(lessonCompletionsTable.userId, lessonCompletionsTable.lessonId);
      const beforeEnrollments = await readEnrollments();
      const beforeCompletions = await readCompletions();
      const failure = new Error(`Injected ${outcome}`);

      if (outcome !== "success") {
        const transaction = db.transaction.bind(db);
        transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) =>
          transaction(async tx => {
            if (outcome === "cleanup failure") {
              const update = tx.update.bind(tx);
              vi.spyOn(tx, "update").mockImplementation(((table: typeof enrollmentsTable) => {
                if (table === enrollmentsTable) {
                  return { set: () => ({ where: () => Promise.reject(failure) }) };
                }
                return update(table);
              }) as typeof tx.update);
            }
            const result = await callback(tx);
            if (outcome === "failure after cleanup") throw failure;
            return result;
          }, config),
        );
      }

      const edited = await request("test-editor", `/lessons/${target.id}`, "PATCH", {
        title: target.title, content: "Edited draft", sortOrder: target.sortOrder,
        durationMinutes: target.durationMinutes,
      });
      expect(edited.status).toBe(outcome === "success" ? 200 : 500);
      const [storedLesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, target.id));
      if (outcome === "success") {
        expect(edited.data).toMatchObject({ id: target.id, content: "Edited draft" });
        expect(storedLesson).toEqual({ ...target, content: "Edited draft", publishedAt: null });
        expect(await readEnrollments()).toEqual(beforeEnrollments.map(row =>
          row.courseId === target.courseId && row.lastLessonId === target.id
            ? { ...row, lastLessonId: null } : row,
        ));
      } else {
        expect(edited.data).toEqual({ error: failure.message });
        expect(storedLesson).toEqual(target);
        expect(await readEnrollments()).toEqual(beforeEnrollments);
      }
      expect(await readCompletions()).toEqual(beforeCompletions);
      expect(await db.select().from(lessonsTable).where(inArray(lessonsTable.id, [sibling.id, other.id]))
        .orderBy(lessonsTable.id)).toEqual([sibling, other]);
    } finally {
      transactionSpy?.mockRestore();
      if (fixtureCourses.length) {
        const lessons = await db.select({ id: lessonsTable.id }).from(lessonsTable)
          .where(inArray(lessonsTable.courseId, fixtureCourses));
        if (lessons.length) await db.delete(lessonCompletionsTable)
          .where(inArray(lessonCompletionsTable.lessonId, lessons.map(lesson => lesson.id)));
        await db.delete(enrollmentsTable).where(inArray(enrollmentsTable.courseId, fixtureCourses));
        await db.delete(lessonsTable).where(inArray(lessonsTable.courseId, fixtureCourses));
        await db.delete(coursesTable).where(inArray(coursesTable.id, fixtureCourses));
      }
    }
  },
);

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
