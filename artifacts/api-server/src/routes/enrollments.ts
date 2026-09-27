import { Router } from "express";
import { db, enrollmentsTable, coursesTable, lessonsTable, lessonCompletionsTable, activityTable, usersTable } from "@workspace/db";
import { eq, and, sql, isNotNull, inArray } from "drizzle-orm";
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

// Enrollment pointers are stored even if editorial review later hides the lesson.
// Check them against the same ordered, published set used by the lesson listings.
async function visibleResumeRows<T extends { courseId: number; courseTitle: string | null; lastLessonId: number | null }>(rows: T[]): Promise<T[]> {
  const approvedRows = rows.filter(row => row.lastLessonId != null && row.courseTitle != null && isApprovedStandaloneCourse(row.courseTitle));
  if (!approvedRows.length) return rows;

  const lessons = await db.select().from(lessonsTable)
    .where(and(inArray(lessonsTable.courseId, [...new Set(approvedRows.map(row => row.courseId))]), isNotNull(lessonsTable.publishedAt)))
    .orderBy(lessonsTable.sortOrder);
  const visibleByCourse = new Map(approvedRows.map(row => [
    row.courseId,
    publishedLessonsForCourse(row.courseTitle!, lessons.filter(lesson => lesson.courseId === row.courseId))[0]?.id,
  ]));
  return rows.map(row => visibleByCourse.has(row.courseId) && visibleByCourse.get(row.courseId) !== row.lastLessonId
    ? { ...row, lastLessonId: null }
    : row);
}

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
      lastLessonId: sql<number | null>`(
        select l.id from lessons l
        where l.id = ${enrollmentsTable.lastLessonId}
          and l.course_id = ${enrollmentsTable.courseId}
          and l.published_at is not null
      )`,
      enrolledAt: enrollmentsTable.enrolledAt,
    })
    .from(enrollmentsTable)
    .leftJoin(coursesTable, eq(enrollmentsTable.courseId, coursesTable.id))
    .where(and(eq(enrollmentsTable.userId, userId), isNotNull(coursesTable.publishedAt)));

  const visibleRows = await visibleResumeRows(rows);
  res.json(ListEnrollmentsResponse.parse(visibleRows.map(r => ({ ...r, enrolledAt: r.enrolledAt?.toISOString() }))));
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

  // A new enrollment and its activity must commit together. On activity failure,
  // the enrollment rolls back so a retry can safely create both rows. The unique
  // index serializes concurrent requests; only the winning insert writes activity.
  const enrollment = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(enrollmentsTable).values({ userId, courseId })
      .onConflictDoNothing({ target: [enrollmentsTable.userId, enrollmentsTable.courseId] })
      .returning();
    if (!inserted) {
      return (await tx.select().from(enrollmentsTable)
        .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)))
        .limit(1))[0];
    }

    try {
      await tx.insert(activityTable).values({
        type: "enrollment",
        description: "enrolled in a course",
        actorName: member.displayName ?? "A learner",
        entityTitle: course.title,
      });
    } catch (err) {
      req.log.error({ err, enrollmentId: inserted.id, courseId }, "Enrollment activity write failed; rolling back enrollment");
      throw err;
    }
    return inserted;
  });
  if (!enrollment) throw new Error("Enrollment missing after conflict");
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt)));
  const [availableLesson] = enrollment.lastLessonId == null ? [] : await db.select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, enrollment.lastLessonId), eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt)))
    .limit(1);

  const [visibleEnrollment] = await visibleResumeRows([{
    ...enrollment,
    lastLessonId: availableLesson?.id ?? null,
    courseTitle: course.title,
  }]);
  res.status(201).json(EnrollInCourseResponse.parse({
    ...visibleEnrollment,
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
    const courseLessons = await db.select().from(lessonsTable)
      .where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt)))
      .orderBy(lessonsTable.sortOrder);
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
