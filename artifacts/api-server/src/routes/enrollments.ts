import { Router } from "express";
import { db, enrollmentsTable, coursesTable, lessonsTable, activityTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
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
      totalLessons: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${enrollmentsTable.courseId})::int`,
      lastLessonId: enrollmentsTable.lastLessonId,
      enrolledAt: enrollmentsTable.enrolledAt,
    })
    .from(enrollmentsTable)
    .leftJoin(coursesTable, eq(enrollmentsTable.courseId, coursesTable.id))
    .where(eq(enrollmentsTable.userId, userId));

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
  if (!course) {
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
    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(eq(lessonsTable.courseId, courseId));
    res.status(201).json(EnrollInCourseResponse.parse({
      ...existing[0],
      courseTitle: course.title,
      totalLessons: totalRow?.count ?? 0,
      enrolledAt: existing[0].enrolledAt?.toISOString(),
    }));
    return;
  }

  const [enrollment] = await db.insert(enrollmentsTable).values({ userId, courseId }).returning();
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(eq(lessonsTable.courseId, courseId));

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

  const [enrollment] = await db.select().from(enrollmentsTable)
    .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)))
    .limit(1);
  if (!enrollment) { res.status(404).json({ error: "Not enrolled" }); return; }

  const [updated] = await db.update(enrollmentsTable)
    .set({ lastLessonId: lessonId, completedLessons: enrollment.completedLessons + 1 })
    .where(and(eq(enrollmentsTable.userId, userId), eq(enrollmentsTable.courseId, courseId)))
    .returning();

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1);
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).where(eq(lessonsTable.courseId, courseId));

  res.json(UpdateProgressResponse.parse({
    ...updated,
    courseTitle: course?.title ?? "",
    totalLessons: totalRow?.count ?? 0,
    enrolledAt: updated.enrolledAt?.toISOString(),
  }));
});

export default router;
