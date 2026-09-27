import { db, categoriesTable, coursesTable, lessonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { acceleratorLessons } from "./accelerator-lessons";

const courseTitle = "The Elevated Everyday Face";
const acceleratorTitle = "The Beauty Mindset Accelerator";

export async function ensureMemberJourneyContent() {
  const [existing] = await db.select().from(coursesTable).where(eq(coursesTable.title, courseTitle)).limit(1);

  let [category] = await db.select().from(categoriesTable).where(eq(categoriesTable.slug, "makeup-mastery")).limit(1);
  if (!category) {
    [category] = await db.insert(categoriesTable).values({
      name: "Makeup Mastery",
      slug: "makeup-mastery",
      icon: "sparkles",
      description: "Practical techniques for polished, confident makeup.",
    }).returning();
  }

  if (!existing) {
  const [course] = await db.insert(coursesTable).values({
    title: courseTitle,
    description: "A free five-part sequence that turns your diagnostic into a polished, repeatable everyday face—and gives you a first win in under an hour.",
    categoryId: category.id,
    difficulty: "Beginner",
    instructorName: "Nikki — Blushing Beauty By Nikki",
    isFeatured: true,
    accessTier: "Free",
    transformationStory: "“I used to save makeup for important days. Now I can look polished in fifteen minutes and still recognize myself.” — Alana",
  }).returning();

  await db.insert(lessonsTable).values([
    { courseId: course.id, sortOrder: 1, title: "Prepare Your Canvas", durationMinutes: 8, content: "Build a skin-first preparation routine that supports smooth, lasting makeup." },
    { courseId: course.id, sortOrder: 2, title: "Even, Never Mask", durationMinutes: 10, content: "Create breathable, targeted coverage that keeps your natural skin visible." },
    { courseId: course.id, sortOrder: 3, title: "Define Your Features", durationMinutes: 12, content: "Bring balance to brows and eyes with simple, repeatable placement." },
    { courseId: course.id, sortOrder: 4, title: "Add Life & Dimension", durationMinutes: 10, content: "Place warmth, color, and light where they naturally lift your face." },
    { courseId: course.id, sortOrder: 5, title: "Finish With Presence", durationMinutes: 8, content: "Refine lips and final details so the finished look feels intentional and like you." },
  ]);
  }

  const [accelerator] = await db.select().from(coursesTable).where(eq(coursesTable.title, acceleratorTitle)).limit(1);
  const [course] = accelerator ? [accelerator] : await db.insert(coursesTable).values({
    title: acceleratorTitle,
    description: "Your first 30–60–90 days of personalized mastery. Work through four foundations at your own pace to build a routine that serves your skin, style, and life.",
    categoryId: category.id,
    difficulty: "Intermediate",
    instructorName: "Nikki — Blushing Beauty By Nikki",
    isFeatured: true,
    accessTier: "Elevated",
  }).returning();

  const existingLessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id));
  for (const [index, lesson] of acceleratorLessons.entries()) {
    const existingLesson = existingLessons.find(row => row.sortOrder === index + 1 && row.title === lesson.title);
    if (existingLesson) {
      if (existingLesson.content !== lesson.content) {
        await db.update(lessonsTable).set({ content: lesson.content }).where(eq(lessonsTable.id, existingLesson.id));
      }
    } else {
      await db.insert(lessonsTable).values({ courseId: course.id, sortOrder: index + 1, ...lesson });
    }
  }
}