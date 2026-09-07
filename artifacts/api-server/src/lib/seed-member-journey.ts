import { db, categoriesTable, coursesTable, lessonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const courseTitle = "The Elevated Everyday Face";

export async function ensureMemberJourneyContent() {
  const [existing] = await db.select().from(coursesTable).where(eq(coursesTable.title, courseTitle)).limit(1);
  if (existing) return;

  let [category] = await db.select().from(categoriesTable).where(eq(categoriesTable.slug, "makeup-mastery")).limit(1);
  if (!category) {
    [category] = await db.insert(categoriesTable).values({
      name: "Makeup Mastery",
      slug: "makeup-mastery",
      icon: "sparkles",
      description: "Practical techniques for polished, confident makeup.",
    }).returning();
  }

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