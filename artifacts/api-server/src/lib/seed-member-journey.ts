import { db, categoriesTable, coursesTable, lessonsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { acceleratorLessons } from "./accelerator-lessons";
import { approvedTopicLessons } from "./approved-topic-lessons";
import { logger } from "./logger";

const courseTitle = "The Elevated Everyday Face";
const acceleratorTitle = "The Beauty Mindset Accelerator";

export async function ensureMemberJourneyContent(backfillLegacy = false) {
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
    publishedAt: new Date(), // Existing launch course; new editorial copy uses the draft API instead.
    transformationStory: "“I used to save makeup for important days. Now I can look polished in fifteen minutes and still recognize myself.” — Alana",
  }).returning();

  await db.insert(lessonsTable).values([
    { courseId: course.id, sortOrder: 1, title: "Prepare Your Canvas", durationMinutes: 8, content: "Build a skin-first preparation routine that supports smooth, lasting makeup.", publishedAt: new Date() },
    { courseId: course.id, sortOrder: 2, title: "Even, Never Mask", durationMinutes: 10, content: "Create breathable, targeted coverage that keeps your natural skin visible.", publishedAt: new Date() },
    { courseId: course.id, sortOrder: 3, title: "Define Your Features", durationMinutes: 12, content: "Bring balance to brows and eyes with simple, repeatable placement.", publishedAt: new Date() },
    { courseId: course.id, sortOrder: 4, title: "Add Life & Dimension", durationMinutes: 10, content: "Place warmth, color, and light where they naturally lift your face.", publishedAt: new Date() },
    { courseId: course.id, sortOrder: 5, title: "Finish With Presence", durationMinutes: 8, content: "Refine lips and final details so the finished look feels intentional and like you.", publishedAt: new Date() },
  ]);
  } else if (backfillLegacy && existing.accessTier === "Free" &&
    existing.description === "A free five-part sequence that turns your diagnostic into a polished, repeatable everyday face—and gives you a first win in under an hour.") {
    // Preserve only the previously shipped introductory sequence on migration.
    const rows = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, existing.id));
    const originalTitles = ["Prepare Your Canvas", "Even, Never Mask", "Define Your Features", "Add Life & Dimension", "Finish With Presence"];
    const originalCopy = [
      "Build a skin-first preparation routine that supports smooth, lasting makeup.",
      "Create breathable, targeted coverage that keeps your natural skin visible.",
      "Bring balance to brows and eyes with simple, repeatable placement.",
      "Place warmth, color, and light where they naturally lift your face.",
      "Refine lips and final details so the finished look feels intentional and like you.",
    ];
    if (rows.length === 5 && originalTitles.every((title, i) =>
      rows.some(row => row.sortOrder === i + 1 && row.title === title && row.content === originalCopy[i]))) {
      await db.update(coursesTable).set({ publishedAt: new Date() }).where(eq(coursesTable.id, existing.id));
      for (const row of rows) await db.update(lessonsTable).set({ publishedAt: new Date() }).where(eq(lessonsTable.id, row.id));
    }
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
    publishedAt: new Date(),
  }).returning();

  const existingLessons = await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id));
  const approvedLegacyAccelerator = Boolean(accelerator && backfillLegacy && accelerator.accessTier === "Elevated" &&
    accelerator.description === "Your first 30–60–90 days of personalized mastery. Work through four foundations at your own pace to build a routine that serves your skin, style, and life." &&
    existingLessons.length === acceleratorLessons.length &&
    acceleratorLessons.every((lesson, index) => existingLessons.some(row =>
      row.sortOrder === index + 1 && row.title === lesson.title && row.content === lesson.content)));
  if (approvedLegacyAccelerator) {
    await db.update(coursesTable).set({ publishedAt: new Date() }).where(eq(coursesTable.id, course.id));
  }
  for (const [index, lesson] of acceleratorLessons.entries()) {
    const existingLesson = existingLessons.find(row => row.sortOrder === index + 1 && row.title === lesson.title);
    if (existingLesson) {
      if (existingLesson.content !== lesson.content) {
        logger.error({ title: lesson.title }, "Approved Accelerator copy differs from stored copy; withholding lesson");
        await db.update(lessonsTable).set({ publishedAt: null }).where(eq(lessonsTable.id, existingLesson.id));
      } else if (approvedLegacyAccelerator) {
        await db.update(lessonsTable).set({ publishedAt: new Date() }).where(eq(lessonsTable.id, existingLesson.id));
      }
    } else {
      await db.insert(lessonsTable).values({ courseId: course.id, sortOrder: index + 1, ...lesson, publishedAt: new Date() });
    }
  }

  // Standalone owner-approved lessons; never append to the four-module Accelerator.
  for (const topic of approvedTopicLessons) {
    let [topicCategory] = await db.select().from(categoriesTable).where(eq(categoriesTable.slug, topic.category.slug)).limit(1);
    if (!topicCategory) {
      [topicCategory] = await db.insert(categoriesTable).values(topic.category).returning();
    }

    let [topicCourse] = await db.select().from(coursesTable).where(eq(coursesTable.approvedTopicKey, topic.title)).limit(1);
    if (!topicCourse) {
      [topicCourse] = await db.insert(coursesTable).values({
        title: topic.title,
        approvedTopicKey: topic.title,
        description: topic.description,
        categoryId: topicCategory.id,
        difficulty: "Beginner",
        instructorName: "Nikki — Blushing Beauty By Nikki",
        isFeatured: false,
        accessTier: "Elevated",
        publishedAt: new Date(),
      }).returning();
    } else if (topicCourse.accessTier !== "Elevated" || topicCourse.categoryId !== topicCategory.id || topicCourse.description !== topic.description) {
      logger.error({ title: topic.title }, "Approved topic course has unexpected metadata; skipping seed");
      if (topicCourse.publishedAt) await db.update(coursesTable).set({ publishedAt: null }).where(eq(coursesTable.id, topicCourse.id));
      continue;
    } else if (backfillLegacy && !topicCourse.publishedAt) {
      await db.update(coursesTable).set({ publishedAt: new Date() }).where(eq(coursesTable.id, topicCourse.id));
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
        publishedAt: new Date(),
      });
    } else if (existingTopicLesson.content !== topic.content) {
      logger.error({ title: topic.title }, "Approved topic copy differs from stored copy; withholding lesson");
      await db.update(lessonsTable).set({ publishedAt: null }).where(eq(lessonsTable.id, existingTopicLesson.id));
    } else if (backfillLegacy && existingTopicLesson.content === topic.content) {
      await db.update(lessonsTable).set({ publishedAt: new Date() }).where(eq(lessonsTable.id, existingTopicLesson.id));
    }
  }
}