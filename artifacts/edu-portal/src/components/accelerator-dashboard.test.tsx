import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import type { CourseDetail, Enrollment } from "@workspace/api-client-react";
import { AcceleratorDashboard } from "./accelerator-dashboard";

const lessonIds = [201, 202, 203, 204];
const course = {
  id: 12,
  title: "The Beauty Mindset Accelerator",
  description: "Four foundations",
  lessons: lessonIds.map((id, sortOrder) => ({ id, title: `Module ${sortOrder + 1}`, sortOrder })),
} as CourseDetail;

function render(ids?: number[], enrolled = true) {
  const enrollment = enrolled
    ? { courseId: course.id, completedLessonIds: ids, completedLessons: ids?.length ?? 0 } as Enrollment
    : null;
  return renderToStaticMarkup(
    <Router hook={() => ["/", () => {}]}>
      <AcceleratorDashboard course={course} enrollment={enrollment} loading={false} />
    </Router>,
  );
}

test("dashboard derives status and destination from lesson identities, not a stale or inflated count", () => {
  const fresh = render([]);
  expect(fresh).toContain("0 of 4 modules complete");
  expect(fresh).toContain('aria-valuenow="0"');
  expect(fresh).toContain(`/courses/12/lessons/${lessonIds[0]}`);

  const partial = render([lessonIds[2], lessonIds[2], lessonIds[0]]);
  expect(partial).toContain("2 of 4 modules complete");
  expect(partial).toContain('aria-valuenow="50"');
  expect(partial).toContain(`href="/courses/12/lessons/${lessonIds[1]}"`);

  const revisited = render([...lessonIds]);
  expect(revisited).toContain("4 of 4 modules complete");
  expect(revisited).toContain('aria-valuenow="100"');
  expect(revisited).toContain("Revisit the course");
  expect(revisited).toContain(`href="/courses/12/lessons/${lessonIds[0]}"`);

  const notEnrolled = render(undefined, false);
  expect(notEnrolled).toContain("Enrollment not started");
  expect(notEnrolled).not.toContain('data-testid="link-accelerator-lesson-201"');
});