import { db, categoriesTable, coursesTable, lessonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { acceleratorLessons } from "./accelerator-lessons";
import { approvedTopicLessons } from "./approved-topic-lessons";
import { logger } from "./logger";

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

  // Standalone owner-approved lessons; never append to the four-module Accelerator.
  for (const topic of approvedTopicLessons) {
    let [topicCategory] = await db.select().from(categoriesTable).where(eq(categoriesTable.slug, topic.category.slug)).limit(1);
    if (!topicCategory) {
      [topicCategory] = await db.insert(categoriesTable).values(topic.category).returning();
    }

    let [topicCourse] = await db.select().from(coursesTable).where(eq(coursesTable.title, topic.title)).limit(1);
    if (!topicCourse) {
      [topicCourse] = await db.insert(coursesTable).values({
        title: topic.title,
        description: topic.description,
        categoryId: topicCategory.id,
        difficulty: "Beginner",
        instructorName: "Nikki — Blushing Beauty By Nikki",
        isFeatured: false,
        accessTier: "Elevated",
      }).returning();
    } else if (topicCourse.accessTier !== "Elevated" || topicCourse.categoryId !== topicCategory.id || topicCourse.description !== topic.description) {
      logger.error({ title: topic.title }, "Approved topic course has unexpected metadata; skipping seed");
      continue;
    }

    const topicLessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, topicCourse.id));
    if (topicLessons.length > 1) {
      logger.error({ title: topic.title }, "Approved topic course has extra lessons; only approved copy is served");
    }
    const existingTopicLesson = topicLessons.find(lesson => lesson.title === topic.title && lesson.sortOrder === 1);
    if (!existingTopicLesson) {
      await db.insert(lessonsTable).values({
        courseId: topicCourse.id,
        sortOrder: 1,
        title: topic.title,
        durationMinutes: topic.durationMinutes,
        content: topic.content,
      });
    } else if (existingTopicLesson.content !== topic.content) {
      await db.update(lessonsTable).set({ content: topic.content }).where(eq(lessonsTable.id, existingTopicLesson.id));
    }
  }
}