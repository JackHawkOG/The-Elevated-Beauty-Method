import { Router } from "express";
import { db, coursesTable, categoriesTable, lessonsTable, enrollmentsTable } from "@workspace/db";
import { eq, ilike, sql, and } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { requireAuth, jitProvisionUser } from "../middlewares/requireAuth";
import { usersTable } from "@workspace/db";
import { canAccessTier } from "../lib/beauty-method";

const router = Router();

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
      lessonCount: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${coursesTable.id})::int`,
      enrollmentCount: sql<number>`(select count(*) from ${enrollmentsTable} where ${enrollmentsTable.courseId} = ${coursesTable.id})::int`,
    })
    .from(coursesTable)
    .leftJoin(categoriesTable, eq(coursesTable.categoryId, categoriesTable.id))
    .where(eq(coursesTable.id, courseId));
  return row;
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
      lessonCount: sql<number>`(select count(*) from ${lessonsTable} where ${lessonsTable.courseId} = ${coursesTable.id})::int`,
      enrollmentCount: sql<number>`(select count(*) from ${enrollmentsTable} where ${enrollmentsTable.courseId} = ${coursesTable.id})::int`,
    })
    .from(coursesTable)
    .leftJoin(categoriesTable, eq(coursesTable.categoryId, categoriesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(limit ?? 50)
    .offset(offset ?? 0)
    .orderBy(coursesTable.createdAt);

  res.json(ListCoursesResponse.parse(rows.map(r => ({ ...r, createdAt: r.createdAt?.toISOString() }))));
});

// POST /courses
router.post("/courses", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [course] = await db.insert(coursesTable).values(parsed.data).returning();
  const row = await buildCourseRow(course.id);
  res.status(201).json(CreateCourseResponse.parse({ ...row, createdAt: row?.createdAt?.toISOString(), lessonCount: 0, enrollmentCount: 0 }));
});

// GET /courses/:courseId
router.get("/courses/:courseId", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const parsed = GetCourseParams.safeParse({ courseId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const row = await buildCourseRow(courseId);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId)).orderBy(lessonsTable.sortOrder);

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
  if (!course) { res.status(404).json({ error: "Not found" }); return; }
  if (!member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: `${course.accessTier} membership required` });
    return;
  }

  const lessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, courseId)).orderBy(lessonsTable.sortOrder);
  res.json(ListLessonsResponse.parse(lessons.map(l => ({ ...l, content: null, videoUrl: null, createdAt: l.createdAt?.toISOString() }))));
});

// POST /courses/:courseId/lessons
router.post("/courses/:courseId/lessons", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.courseId) ? req.params.courseId[0] : req.params.courseId;
  const courseId = parseInt(rawId, 10);
  if (isNaN(courseId)) { res.status(400).json({ error: "Invalid courseId" }); return; }

  const paramsParsed = CreateLessonParams.safeParse({ courseId });
  if (!paramsParsed.success) { res.status(400).json({ error: paramsParsed.error.message }); return; }

  const bodyParsed = CreateLessonBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: bodyParsed.error.message }); return; }

  const [lesson] = await db.insert(lessonsTable).values({ ...bodyParsed.data, courseId }).returning();
  res.status(201).json(CreateLessonResponse.parse({ ...lesson, createdAt: lesson.createdAt?.toISOString() }));
});

// GET /lessons/:lessonId
router.get("/lessons/:lessonId", requireAuth, jitProvisionUser, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(rawId, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lessonId" }); return; }

  const parsed = GetLessonParams.safeParse({ lessonId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Not found" }); return; }
  const [[course], [member]] = await Promise.all([
    db.select().from(coursesTable).where(eq(coursesTable.id, lesson.courseId)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1),
  ]);
  if (!course || !member || !canAccessTier(member.membershipTier, course.accessTier)) {
    res.status(403).json({ error: `${course?.accessTier ?? "Required"} membership required` });
    return;
  }

  res.json(GetLessonResponse.parse({ ...lesson, createdAt: lesson.createdAt?.toISOString() }));
});

export default router;
