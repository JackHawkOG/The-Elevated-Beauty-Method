import { db, categoriesTable, coursesTable, lessonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
  if (accelerator) return;
  const [course] = await db.insert(coursesTable).values({
    title: acceleratorTitle,
    description: "Your first 30–60–90 days of personalized mastery. Work through four foundations at your own pace to build a routine that serves your skin, style, and life.",
    categoryId: category.id,
    difficulty: "Intermediate",
    instructorName: "Nikki — Blushing Beauty By Nikki",
    isFeatured: true,
    accessTier: "Elevated",
  }).returning();

  await db.insert(lessonsTable).values([
    { courseId: course.id, sortOrder: 1, title: "Your Personal Beauty Blueprint", content: "Assess your skin type, undertones, and lifestyle to build your custom foundation.\n\nReflect: What does your skin need today, and what kind of routine fits your life?", durationMinutes: 10 },
    { courseId: course.id, sortOrder: 2, title: "The Makeup Method Essentials", content: "Identify five essential products matched to your needs, then consider the application techniques that make each one work for you.\n\nReflect: Which steps support your features and which can you simplify?", durationMinutes: 10 },
    { courseId: course.id, sortOrder: 3, title: "The Skincare Method Essentials", content: "Build a clear, evidence-informed routine around your skin concerns rather than passing trends.\n\nReflect: Which steps can you repeat consistently?", durationMinutes: 10 },
    { courseId: course.id, sortOrder: 4, title: "The Personal Method Principles", content: "Learn to evaluate and update your routine as your skin and life evolve.\n\nReflect: What would make your method sustainable in the next season of life?", durationMinutes: 10 },
  ]);
}