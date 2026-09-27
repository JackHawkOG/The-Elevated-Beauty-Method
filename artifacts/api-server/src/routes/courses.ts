import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { db, coursesTable, categoriesTable, lessonsTable, enrollmentsTable } from "@workspace/db";
import { eq, ilike, sql, and, isNotNull } from "drizzle-orm";
import {
  ListCoursesQueryParams,
  ListCoursesResponse,
  CreateCourseBody,
  CreateCourseResponse,
  GetCourseParams,
  GetCourseResponse,
  ListLessonsParams,
  ListLessonsResponse,
  CreateLessonParams,
  CreateLessonBody,
  CreateLessonResponse,
  GetLessonParams,
  GetLessonResponse,
  UpdateCourseBody,
  UpdateLessonBody,
  ApproveCourseBody,
  ApproveLessonBody,
  ReviewCourseResponse,
  ReviewLessonResponse,
  ListEditorialCoursesResponse,
} from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";
import { usersTable } from "@workspace/db";
import { canAccessTier } from "../lib/beauty-method";
import { isApprovedStandaloneCourse, publishedLessonsForCourse } from "../lib/approved-topic-lessons";

const router = Router();

// Authenticated members are not content editors. Clerk public metadata is
// server-managed; if no editor role is configured, authoring fails closed.
async function requireContentEditor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (!["admin", "owner", "editor"].includes(String(user.publicMetadata.role))) {
      res.status(403).json({ error: "Editor access required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Could not verify content editor");
    res.status(503).json({ error: "Unable to verify editor access" });
  }
}

async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (user.publicMetadata.role !== "admin" && user.publicMetadata.role !== "owner") {
      res.status(403).json({ error: "Owner approval required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Could not verify owner");
    res.status(503).json({ error: "Unable to verify owner access" });
  }
}

function numericId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

// Include the complete editorial payload in the revision, not just teaching text.
function courseRevision(course: typeof coursesTable.$inferSelect): string {
  const { id, createdAt, publishedAt, ...copy } = course;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

function lessonRevision(lesson: typeof lessonsTable.$inferSelect): string {
  const { id, createdAt, publishedAt, ...copy } = lesson;
  return createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}

// Course with aggregated counts
async function buildCourseRow(courseId: number) {
  const [row] = await db
    .select({
      id: coursesTable.id,
      title: coursesTable.title,
      description: coursesTable.description,
      categoryId: coursesTable.categoryId,
      categoryName: categoriesTable.name,
      difficulty: coursesTable.difficulty,
      instructorName: coursesTable.instructorName,
      thumbnailUrl: coursesTable.thumbnailUrl,
      isFeatured: coursesTable.isFeatured,
      accessTier: coursesTable.accessTier,
      transformationStory: coursesTable.transformationStory,
      createdAt: coursesTable.createdAt,
      lessonCount: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${coursesTable.id} and ${lessonsTable.publishedAt} is not null)::int`,
      enrollmentCount: sql<number>`(select count(*) from ${enrollmentsTable} where ${enrollmentsTable.courseId} = ${coursesTable.id})::int`,
    })
    .from(coursesTable)
    .leftJoin(categoriesTable, eq(coursesTable.categoryId, categoriesTable.id))
    .where(eq(coursesTable.id, courseId));
  return row && isApprovedStandaloneCourse(row.title)
    ? { ...row, lessonCount: Math.min(1, row.lessonCount) }
    : row;
}

// GET /courses
router.get("/courses", async (req, res): Promise<void> => {
  const parsed = ListCoursesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { categoryId, search, difficulty, limit = 50, offset = 0 } = parsed.data;

  const conditions = [];
  conditions.push(isNotNull(coursesTable.publishedAt));
  if (categoryId) conditions.push(eq(coursesTable.categoryId, categoryId));
  if (search) conditions.push(ilike(coursesTable.title, `%${search}%`));
  if (difficulty) conditions.push(eq(coursesTable.difficulty, difficulty));

  const rows = await db
    .select({
      id: coursesTable.id,
      title: coursesTable.title,
      description: coursesTable.description,
      categoryId: coursesTable.categoryId,
      categoryName: categoriesTable.name,
      difficulty: coursesTable.difficulty,
      instructorName: coursesTable.instructorName,
      thumbnailUrl: coursesTable.thumbnailUrl,
      isFeatured: coursesTable.isFeatured,
      accessTier: coursesTable.accessTier,
      transformationStory: coursesTable.transformationStory,
      createdAt: coursesTable.createdAt,
      lessonCount: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${coursesTable.id} and ${lessonsTable.publishedAt} is not null)::int`,
      enrollmentCount: sql<number>`(select count(*) from ${enrollmentsTable} where ${enrollmentsTable.courseId} = ${coursesTable.id})::int`,
    })
    .from(coursesTable)
    .leftJoin(categoriesTable, eq(coursesTable.categoryId, categoriesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(limit ?? 50)
    .offset(offset ?? 0)
    .orderBy(coursesTable.createdAt);

  res.json(ListCoursesResponse.parse(rows.map(r => ({
    ...r,
    lessonCount: isApprovedStandaloneCourse(r.title) ? Math.min(1, r.lessonCount) : r.lessonCount,
    createdAt: r.createdAt?.toISOString(),
  }))));
});

// POST /courses
router.post("/courses", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const parsed = CreateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (isApprovedStandaloneCourse(parsed.data.title)) {
    res.status(403).json({ error: "Approved standalone courses are managed through editorial review" });
    return;
  }
  const [course] = await db.insert(coursesTable).values({ ...parsed.data, publishedAt: null }).returning();
  const row = await buildCourseRow(course.id);
  res.status(201).json(CreateCourseResponse.parse({ ...row, createdAt: row?.createdAt?.toISOString(), lessonCount: 0, enrollmentCount: 0 }));
});

// Replacing copy withdraws it immediately. Only the owner can explicitly approve the new revision.
router.patch("/courses/:courseId", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const id = numericId(req.params.courseId);
  if (!id) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const parsed = UpdateCourseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [current] = await db.select().from(coursesTable).where(eq(coursesTable.id, id));
  if (!current) { res.status(404).json({ error: "Not found" }); return; }
  if (isApprovedStandaloneCourse(current.title) || isApprovedStandaloneCourse(parsed.data.title)) {
    res.status(403).json({ error: "Approved standalone courses are managed through editorial review" }); return;
  }
  await db.update(coursesTable).set({ ...parsed.data, publishedAt: null }).where(eq(coursesTable.id, id));
  const row = await buildCourseRow(id);
  res.json(CreateCourseResponse.parse({ ...row, createdAt: row?.createdAt?.toISOString() }));
});

router.post("/courses/:courseId/approve", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const id = numericId(req.params.courseId);
  if (!id) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const parsed = ApproveCourseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const result = await db.transaction(async tx => {
    const [current] = await tx.select().from(coursesTable).where(eq(coursesTable.id, id)).for("update");
    if (!current) return "missing";
    if (isApprovedStandaloneCourse(current.title)) return "reserved";
    if (current.publishedAt || courseRevision(current) !== parsed.data.revision) return "stale";
    await tx.update(coursesTable).set({ publishedAt: new Date() }).where(eq(coursesTable.id, id));
    return "approved";
  });
  if (result !== "approved") {
    res.status(result === "missing" ? 404 : result === "reserved" ? 403 : 409).json({ error: result === "stale" ? "Draft changed since review" : "Course unavailable for approval" }); return;
  }
  const row = await buildCourseRow(id);
  res.json(CreateCourseResponse.parse({ ...row, createdAt: row?.createdAt?.toISOString() }));
});

router.get("/editorial/courses", requireAuth, requireContentEditor, async (_req, res): Promise<void> => {
  const courses = await db.select({
    id: coursesTable.id, title: coursesTable.title,
    accessTier: coursesTable.accessTier, publishedAt: coursesTable.publishedAt,
  }).from(coursesTable).orderBy(coursesTable.createdAt);
  const lessons = await db.select({
    id: lessonsTable.id, courseId: lessonsTable.courseId, title: lessonsTable.title,
    sortOrder: lessonsTable.sortOrder, publishedAt: lessonsTable.publishedAt,
  }).from(lessonsTable).orderBy(lessonsTable.sortOrder);
  res.json(ListEditorialCoursesResponse.parse(courses.filter(course => !isApprovedStandaloneCourse(course.title)).map(course => {
    const courseLessons = lessons.filter(lesson => lesson.courseId === course.id);
    return {
      ...course,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      lessons: courseLessons.map(({ courseId: _courseId, ...lesson }) => ({
        ...lesson, publishedAt: lesson.publishedAt?.toISOString() ?? null,
      })),
    };
  }).filter(course => !course.publishedAt || course.lessons.some(lesson => !lesson.publishedAt))));
});

router.get("/editorial/courses/:courseId", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const id = numericId(req.params.courseId);
  if (!id) { res.status(400).json({ error: "Invalid courseId" }); return; }
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, id));
  if (!course) { res.status(404).json({ error: "Not found" }); return; }
  const row = await buildCourseRow(id);
  res.json(ReviewCourseResponse.parse({
    ...row, createdAt: course.createdAt.toISOString(),
    publishedAt: course.publishedAt?.toISOString() ?? null, revision: courseRevision(course),
  }));
});

// GET /courses/:courseId
router.get("/courses/:courseId", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const parsed = GetCourseParams.safeParse({ courseId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const row = await buildCourseRow(courseId);
  const [course] = await db.select({ publishedAt: coursesTable.publishedAt }).from(coursesTable).where(eq(coursesTable.id, courseId));
  if (!row || !course?.publishedAt) { res.status(404).json({ error: "Not found" }); return; }

  const lessons = publishedLessonsForCourse(
    row.title,
    await db.select().from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt))).orderBy(lessonsTable.sortOrder),
  );

  res.json(GetCourseResponse.parse({
    ...row,
    createdAt: row.createdAt?.toISOString(),
    lessons: lessons.map(l => ({ ...l, content: null, videoUrl: null, createdAt: l.createdAt?.toISOString() })),
  }));
});

// GET /courses/:courseId/lessons
router.get("/courses/:courseId/lessons", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const parsed = ListLessonsParams.safeParse({ courseId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [[course], [member]] = await Promise.all([
    db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1),
  ]);
  if (!course?.publishedAt) { res.status(404).json({ error: "Not found" }); return; }
  if (!member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: `${course.accessTier} membership required` });
    return;
  }

  const lessons = publishedLessonsForCourse(
    course.title,
    await db.select().from(lessonsTable).where(and(eq(lessonsTable.courseId, courseId), isNotNull(lessonsTable.publishedAt))).orderBy(lessonsTable.sortOrder),
  );
  res.json(ListLessonsResponse.parse(lessons.map(l => ({ ...l, content: null, videoUrl: null, createdAt: l.createdAt?.toISOString() }))));
});

// POST /courses/:courseId/lessons
router.post("/courses/:courseId/lessons", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const [targetCourse] = await db.select().from(coursesTable).where(eq(coursesTable.id, courseId)).limit(1);
  if (!targetCourse) { res.status(404).json({ error: "Not found" }); return; }
  if (isApprovedStandaloneCourse(targetCourse.title)) {
    res.status(403).json({ error: "Approved standalone lesson copy cannot be changed through this route" });
    return;
  }

  const paramsParsed = CreateLessonParams.safeParse({ courseId });
  if (!paramsParsed.success) { res.status(400).json({ error: paramsParsed.error.message }); return; }

  const bodyParsed = CreateLessonBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: bodyParsed.error.message }); return; }

  const [lesson] = await db.insert(lessonsTable).values({ ...bodyParsed.data, courseId, publishedAt: null }).returning();
  res.status(201).json(CreateLessonResponse.parse({ ...lesson, createdAt: lesson.createdAt?.toISOString() }));
});

router.patch("/lessons/:lessonId", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const id = numericId(req.params.lessonId);
  if (!id) { res.status(400).json({ error: "Invalid lessonId" }); return; }
  const parsed = UpdateLessonBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id));
  if (!lesson) { res.status(404).json({ error: "Not found" }); return; }
  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, lesson.courseId));
  if (course && isApprovedStandaloneCourse(course.title)) {
    res.status(403).json({ error: "Approved standalone copy is managed through editorial review" }); return;
  }
  const [updated] = await db.update(lessonsTable).set({ ...parsed.data, publishedAt: null }).where(eq(lessonsTable.id, id)).returning();
  res.json(CreateLessonResponse.parse({ ...updated, createdAt: updated.createdAt.toISOString() }));
});

router.post("/lessons/:lessonId/approve", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const id = numericId(req.params.lessonId);
  if (!id) { res.status(400).json({ error: "Invalid lessonId" }); return; }
  const parsed = ApproveLessonBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const result = await db.transaction(async tx => {
    const [lesson] = await tx.select().from(lessonsTable).where(eq(lessonsTable.id, id)).for("update");
    if (!lesson) return { status: "missing" as const };
    const [course] = await tx.select().from(coursesTable).where(eq(coursesTable.id, lesson.courseId));
    if (!course || isApprovedStandaloneCourse(course.title)) return { status: "reserved" as const };
    if (lesson.publishedAt || lessonRevision(lesson) !== parsed.data.revision) return { status: "stale" as const };
    const [updated] = await tx.update(lessonsTable).set({ publishedAt: new Date() }).where(eq(lessonsTable.id, id)).returning();
    return { status: "approved" as const, updated };
  });
  if (result.status !== "approved") {
    res.status(result.status === "missing" ? 404 : result.status === "reserved" ? 403 : 409).json({ error: result.status === "stale" ? "Draft changed since review" : "Lesson unavailable for approval" }); return;
  }
  const { updated } = result;
  res.json(CreateLessonResponse.parse({ ...updated, createdAt: updated.createdAt.toISOString() }));
});

router.get("/editorial/lessons/:lessonId", requireAuth, requireContentEditor, async (req, res): Promise<void> => {
  const id = numericId(req.params.lessonId);
  if (!id) { res.status(400).json({ error: "Invalid lessonId" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id));
  if (!lesson) { res.status(404).json({ error: "Not found" }); return; }
  res.json(ReviewLessonResponse.parse({
    ...lesson, createdAt: lesson.createdAt.toISOString(),
    publishedAt: lesson.publishedAt?.toISOString() ?? null, revision: lessonRevision(lesson),
  }));
});

// GET /lessons/:lessonId
router.get("/lessons/:lessonId", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(rawId, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lessonId" }); return; }

  const parsed = GetLessonParams.safeParse({ lessonId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson?.publishedAt) { res.status(404).json({ error: "Not found" }); return; }
  const [[course], [member]] = await Promise.all([
    db.select().from(coursesTable).where(eq(coursesTable.id, lesson.courseId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1),
  ]);
  if (!course?.publishedAt) { res.status(404).json({ error: "Not found" }); return; }
  if (!member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: `${course?.accessTier ?? "Required"} membership required` });
    return;
  }

  if (isApprovedStandaloneCourse(course.title)) {
    const courseLessons = await db.select().from(lessonsTable)
      .where(and(eq(lessonsTable.courseId, course.id), isNotNull(lessonsTable.publishedAt)))
      .orderBy(lessonsTable.sortOrder);
    if (publishedLessonsForCourse(course.title, courseLessons)[0]?.id !== lesson.id) {
      res.status(404).json({ error: "Lesson not published" });
      return;
    }
  }

  res.json(GetLessonResponse.parse({ ...lesson, createdAt: lesson.createdAt?.toISOString() }));
});

export default router;
