import { Router } from "express";
import { db, categoriesTable, coursesTable, lessonsTable, enrollmentsTable, announcementsTable, activityTable } from "@workspace/db";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  GetDashboardStatsResponse,
  GetFeaturedCoursesResponse,
  GetRecentActivityResponse,
} from "@workspace/api-zod";

const router = Router();

// GET /dashboard/stats
router.get("/dashboard/stats", async (req, res): Promise<void> => {
  const [[cats], [crs], [les], [enr], [ann]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(categoriesTable),
    db.select({ count: sql<number>`count(*)::int` }).from(coursesTable).where(isNotNull(coursesTable.publishedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(lessonsTable).innerJoin(coursesTable, eq(lessonsTable.courseId, coursesTable.id))
      .where(and(isNotNull(lessonsTable.publishedAt), isNotNull(coursesTable.publishedAt))),
    db.select({ count: sql<number>`count(*)::int` }).from(enrollmentsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(announcementsTable),
  ]);

  res.json(GetDashboardStatsResponse.parse({
    totalCategories: cats?.count ?? 0,
    totalCourses: crs?.count ?? 0,
    totalLessons: les?.count ?? 0,
    totalEnrollments: enr?.count ?? 0,
    totalAnnouncements: ann?.count ?? 0,
  }));
});

// GET /dashboard/featured
router.get("/dashboard/featured", async (req, res): Promise<void> => {
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
    .where(and(eq(coursesTable.isFeatured, true), isNotNull(coursesTable.publishedAt)))
    .limit(6)
    .orderBy(desc(coursesTable.createdAt));

  res.json(GetFeaturedCoursesResponse.parse(rows.map(r => ({
    ...r,
    createdAt: r.createdAt?.toISOString(),
  }))));
});

// GET /dashboard/recent-activity
router.get("/dashboard/recent-activity", async (req, res): Promise<void> => {
  const rows = await db.select().from(activityTable).orderBy(desc(activityTable.createdAt)).limit(15);

  res.json(GetRecentActivityResponse.parse(rows.map(r => ({ ...r, createdAt: r.createdAt?.toISOString() }))));
});

export default router;
