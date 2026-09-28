import { db, lessonsTable } from "@workspace/db";
import { and, inArray, isNotNull } from "drizzle-orm";

// Owner-approved standalone Tier 2 lessons. Exact teaching copy is recorded in
// docs/beauty-topic-bank-review.md; changes to this copy require renewed approval.
export const approvedTopicLessons = [
  {
    title: "Hair care that fits your scalp and schedule",
    category: { name: "Hair Styling & Care", slug: "hair-styling-care", icon: "sparkles", description: "Practical, gentle approaches to hair care and styling." },
    description: "Choose a wash and styling routine based on your own hair and scalp needs.",
    durationMinutes: 7,
    content: `**Outcome:** Choose a wash and styling routine based on your own hair and scalp needs.

There is no single wash schedule that works for everyone. Notice how your scalp feels, how quickly oil or product builds up, and how your hair responds between washes. Wash when you need to for comfort and cleanliness, using a shampoo suited to your hair and scalp and following its directions. Focus cleansing on the scalp and condition where your hair needs it. You do not have to push through weeks of discomfort to “train” your scalp.

For a change in shape or volume, start with low-tension options such as adjusting your part or using a product according to its label. If you use a heated tool, follow its instructions, use a low or medium setting appropriate for your hair, and avoid repeating passes unnecessarily. Never use heat to remove an elastic. If you wear extensions, pain or tightness is a sign to ask your stylist to adjust them, not something to endure. For persistent itching, flaking, or hair loss, consult a qualified clinician instead of treating it with DIY oils.

**Try it:** Write down when your scalp feels comfortable, when it needs cleansing, and one low-tension styling choice you enjoy. Adjust one part of your routine only if you want to.`,
  },
  {
    title: "Dress and pose for your own presence",
    category: { name: "Body-Style & Image", slug: "body-style-image", icon: "sparkles", description: "Personal styling and photography choices that prioritize comfort." },
    description: "Prepare an outfit and a photo setup that feel comfortable and express your intent.",
    durationMinutes: 7,
    content: `**Outcome:** Prepare an outfit and a photo setup that feel comfortable and express your intent.

A flattering photo does not require making your body look smaller. Before a headshot or event, decide what you want the image to communicate. Choose clothes you can move and sit in comfortably; check the fit while standing and seated, regardless of the size on the label. Color and fabric can change the visual effect under different lighting, but there are no colors or silhouettes you must avoid because of your body shape, age, or income.

For a photo, try a few natural positions: face the camera or turn slightly, relax your hands, and shift your posture until you feel at ease. Ask to see a test shot and decide what you like. If a direction feels uncomfortable, you can say so and try another. You do not need professional hair, makeup, expensive clothing, or a particular expression to make a useful headshot. For makeup on scars, bruises, or tattoos, use products only on intact skin and follow their directions; a new or unexplained skin change should be discussed with a clinician, not covered as a substitute for care.

**Try it:** Put together one outfit from what you own and take two test photos in different light or positions. Choose the one that feels most like you and note why.`,
  },
  {
    title: "Choose products without a “perfect” price tag",
    category: { name: "Makeup Mastery", slug: "makeup-mastery", icon: "sparkles", description: "Practical techniques for polished, confident makeup." },
    description: "Compare two products by fit, usability, and cost instead of assuming price predicts quality.",
    durationMinutes: 7,
    content: `**Outcome:** Compare two products by fit, usability, and cost instead of assuming price predicts quality.

A higher price does not guarantee a better match or a better experience. Start with the result you want, such as comfortable coverage or a color you enjoy. Compare the shade in suitable light, the finish and feel on your skin, how you would apply it, the product's size and use-by guidance, and the price per amount you will realistically use. A lower-priced alternative may be a useful choice, but two products called “dupes” are not necessarily identical in ingredients, wear, or how they feel on you.

Try a sample or patch-test as directed when possible, especially if your skin reacts easily. Stop using a product that causes irritation; ask a qualified clinician about persistent symptoms. Keep products you already like rather than buying replacements simply because a list calls them essentials. Your preferences may change over time, and that does not mean an earlier purchase was a mistake. Makeup can help you express a look you enjoy; it cannot promise self-love, healing, or a lasting personal transformation.

**Try it:** Pick a product role you actually use. Compare an item you own with one alternative on shade, comfort, application, and cost. Buying neither is a valid decision.`,
  },
] as const;

// Filter unexpected rows without deleting data or preventing the API from starting.
// Only the lowest-ID exact, approved lesson in each standalone course is publishable.
// Choose here rather than relying on the order in which a query returns tied rows.
export function publishedLessonsForCourse<T extends { id: number; title: string; content: string | null; sortOrder: number }>(
  courseTitle: string,
  lessons: T[],
): T[] {
  const approved = approvedTopicLessons.find(topic => topic.title === courseTitle);
  if (!approved) return lessons;
  return lessons.filter(lesson =>
    lesson.title === approved.title &&
    lesson.content === approved.content &&
    lesson.sortOrder === 1
  ).sort((a, b) => a.id - b.id).slice(0, 1);
}

export function isApprovedStandaloneCourse(courseTitle: string): boolean {
  return approvedTopicLessons.some(topic => topic.title === courseTitle);
}

// Fetch once for a page of courses, then apply the same exact-copy rule as the
// learner's lesson listing. Ordinary course counts still use published rows.
export async function approvedVisibleLessonIds(
  courses: { id: number; title: string }[],
): Promise<Map<number, number[]>> {
  const approvedCourses = courses.filter(course => isApprovedStandaloneCourse(course.title));
  if (!approvedCourses.length) return new Map();
  const lessons = await db.select().from(lessonsTable)
    .where(and(inArray(lessonsTable.courseId, approvedCourses.map(course => course.id)), isNotNull(lessonsTable.publishedAt)))
    .orderBy(lessonsTable.sortOrder, lessonsTable.id);
  return new Map(approvedCourses.map(course => [
    course.id,
    publishedLessonsForCourse(course.title, lessons.filter(lesson => lesson.courseId === course.id)).map(lesson => lesson.id),
  ]));
}