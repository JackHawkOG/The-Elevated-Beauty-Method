import { Router } from "express";
import { db, enrollmentsTable, coursesTable, lessonsTable, lessonCompletionsTable, activityTable, usersTable } from "@workspace/db";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import {
  ListEnrollmentsResponse,
  EnrollInCourseBody,
  EnrollInCourseResponse,
  UpdateProgressParams,
  UpdateProgressBody,
  UpdateProgressResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { canAccessTier } from "../lib/beauty-method";
import { isApprovedStandaloneCourse, publishedLessonsForCourse } from "../lib/approved-topic-lessons";

const router = Router();

// GET /enrollments
router.get("/enrollments", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const rows = await db
    .select({
      id: enrollmentsTable.id,
      courseId: enrollmentsTable.courseId,
      courseTitle: coursesTable.title,
      userId: enrollmentsTable.userId,
      completedLessons: enrollmentsTable.completedLessons,
      completedLessonIds: sql<number[]>`coalesce((select array_agg(lc.lesson_id order by lc.lesson_id) from lesson_completions lc inner join lessons l on l.id = lc.lesson_id where lc.user_id = ${enrollmentsTable.userId} and l.course_id = ${enrollmentsTable.courseId} and l.published_at is not null), ARRAY[]::integer[])`,
      totalLessons: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${enrollmentsTable.courseId} and ${lessonsTable.publishedAt} is not null)::int`,
      lastLessonId: enrollmentsTable.lastLessonId,
      enrolledAt: enrollmentsTable.enrolledAt,
    })
    .from(enrollmentsTable)
    .leftJoin(coursesTable, eq(enrollmentsTable.courseId, coursesTable.id))
    .where(and(eq(enrollmentsTable.userId, userId), isNotNull(coursesTable.publishedAt)));

  res.json(ListEnrollmentsResponse.parse(rows.map(r => ({ ...r, enrolledAt: r.enrolledAt?.toISOString() }))));
});

// POST /enrollments
router.post("/enrollments", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const parsed = EnrollInCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { courseId } = parsed.data;
  const [[course], [member]] = await Promise.all([
    db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1),
  ]);
  if (!course?.publishedAt) {
    res.status(404).json({ error: "Course not found" });
    return;
  }
  if (!member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: `${course.accessTier} membership required` });
    return;
  }

  // Idempotent — return existing if already enrolled
  const existing = await db.select().from(enrollmentsTable)
    .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)))
    .limit(1);
  if (existing.length > 0) {
    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt)));
    res.status(201).json(EnrollInCourseResponse.parse({
      ...existing[0],
      courseTitle: course.title,
      totalLessons: totalRow?.count ?? 0,
      enrolledAt: existing[0].enrolledAt?.toISOString(),
    }));
    return;
  }

  const [enrollment] = await db.insert(enrollmentsTable).values({ userId, courseId }).returning();
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt)));

  // Log activity
  const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1);
  await db.insert(activityTable).values({
    type: "enrollment",
    description: `enrolled in a course`,
    actorName: dbUser?.displayName ?? "A learner",
    entityTitle: course.title,
  }).catch(() => {});

  res.status(201).json(EnrollInCourseResponse.parse({
    ...enrollment,
    courseTitle: course.title,
    totalLessons: totalRow?.count ?? 0,
    enrolledAt: enrollment.enrolledAt?.toISOString(),
  }));
});

// PATCH /enrollments/:courseId/progress
router.patch("/enrollments/:courseId/progress", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const paramsParsed = UpdateProgressParams.safeParse({ courseId });
  if (!paramsParsed.success) { res.status(400).json({ error: paramsParsed.error.message }); return; }

  const bodyParsed = UpdateProgressBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: bodyParsed.error.message }); return; }

  const { lessonId } = bodyParsed.data;

  const [[lesson], [course], [member]] = await Promise.all([
    db.select().from(lessonsTable).where(and(eq(lessonsTable.id, lessonId), eq(lessonsTable.courseId, courseId))).limit(1),
    db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1),
  ]);
  if (!lesson?.publishedAt) { res.status(400).json({ error: "Lesson does not belong to this course" }); return; }
  if (!course?.publishedAt || !member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: "Membership required" }); return;
  }
  if (isApprovedStandaloneCourse(course.title)) {
    const courseLessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId)).orderBy(lessonsTable.sortOrder);
    if (publishedLessonsForCourse(course.title, courseLessons)[0]?.id !== lessonId) {
      res.status(404).json({ error: "Lesson not published" }); return;
    }
  }

  const result = await db.transaction(async (tx) => {
    // Lock this member's enrollment before reading or updating its progress.
    // Concurrent completions and retries then serialize on the same row.
    const [enrollment] = await tx.select().from(enrollmentsTable)
      .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)))
      .for("update")
      .limit(1);
    if (!enrollment) return null;

    await tx.insert(lessonCompletionsTable)
      .values({ userId, lessonId })
      .onConflictDoNothing();
    const [[totalRow], [completedRow]] = await Promise.all([
      tx.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt))),
      tx.select({ count: sql<number>`count(*)::int` }).from(lessonCompletionsTable)
        .innerJoin(lessonsTable, eq(lessonCompletionsTable.lessonId, lessonsTable.id))
        .where(and(eq(lessonCompletionsTable.userId, userId), eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt))),
    ]);
    const [updated] = await tx.update(enrollmentsTable)
      .set({ lastLessonId: lessonId, completedLessons: completedRow.count })
      .where(eq(enrollmentsTable.id, enrollment.id))
      .returning();
    return { updated, totalLessons: totalRow.count };
  });
  if (!result) { res.status(404).json({ error: "Not enrolled" }); return; }

  res.json(UpdateProgressResponse.parse({
    ...result.updated,
    courseTitle: course?.title ?? "",
    totalLessons: result.totalLessons,
    enrolledAt: result.updated.enrolledAt?.toISOString(),
  }));
});

export default router;
