import { expect, test, type Page } from "@playwright/test";

const coursePath = "/courses/7";
const lessonPath = `${coursePath}/lessons/42`;
const lesson = { id: 42, courseId: 7, title: "First lesson", content: "Read this lesson", videoUrl: null };
const nextLesson = { id: 43, courseId: 7, title: "Next lesson", content: "Read the next lesson", videoUrl: null };

async function stubLesson(page: Page) {
  await page.route("**/api/courses/7", route => route.fulfill({ json: { id: 7, title: "Test course" } }));
  await page.route("**/api/lessons/42", route => route.fulfill({ json: lesson }));
  await page.route("**/api/enrollments", route => route.fulfill({ json: [] }));
}

async function expectLocation(page: Page, path: string) {
  await expect(page.getByTestId("current-location")).toHaveText(path);
}

test("a failed outline offers retry, then a completed lesson goes to the actual next lesson", async ({ page }) => {
  await stubLesson(page);
  let outlineRequests = 0;
  await page.route("**/api/courses/7/lessons", route => {
    outlineRequests++;
    return outlineRequests === 1
      ? route.fulfill({ status: 503, json: { message: "Outline unavailable" } })
      : route.fulfill({ json: [lesson, nextLesson] });
  });
  let progressSaves = 0;
  await page.route("**/api/enrollments/7/progress", route => {
    progressSaves++;
    return route.fulfill({ json: { courseId: 7, completedLessonIds: [42] } });
  });

  await page.goto("/tests/lesson-harness.html");
  await expect(page.getByText(lesson.content, { exact: true })).toBeVisible();
  await expect(page.getByTestId("status-outline-unavailable")).toBeVisible();
  await expect(page.getByTestId("button-retry-outline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark Complete" })).toBeDisabled();
  await expectLocation(page, lessonPath);
  expect(progressSaves).toBe(0);

  await page.getByTestId("button-retry-outline").click();
  await expect(page.getByTestId("status-outline-unavailable")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Complete & Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Complete & Continue" }).click();
  await expectLocation(page, `${coursePath}/lessons/43`);
  expect(outlineRequests).toBe(2);
  expect(progressSaves).toBe(1);
});

test("completing a genuinely final lesson returns to the course overview", async ({ page }) => {
  await stubLesson(page);
  await page.route("**/api/courses/7/lessons", route => route.fulfill({ json: [lesson] }));
  await page.route("**/api/enrollments/7/progress", route =>
    route.fulfill({ json: { courseId: 7, completedLessonIds: [42] } }));

  await page.goto("/tests/lesson-harness.html");
  await page.getByRole("button", { name: "Finish Course" }).click();
  await expectLocation(page, coursePath);
});

test("a failed outline refresh during a progress save never treats the lesson as final", async ({ page }) => {
  await stubLesson(page);
  let outlineRequests = 0;
  await page.route("**/api/courses/7/lessons", route => {
    outlineRequests++;
    return outlineRequests === 1
      ? route.fulfill({ json: [lesson, nextLesson] })
      : route.fulfill({ status: 503, json: { message: "Outline unavailable" } });
  });
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>(resolve => { releaseSave = resolve; });
  let saveStarted!: () => void;
  const saveRequested = new Promise<void>(resolve => { saveStarted = resolve; });
  await page.route("**/api/enrollments/7/progress", async route => {
    saveStarted();
    await saveHeld;
    await route.fulfill({ json: { courseId: 7, completedLessonIds: [42] } });
  });

  await page.goto("/tests/lesson-harness.html");
  await page.getByRole("button", { name: "Complete & Continue" }).click();
  await saveRequested;
  await page.getByRole("button", { name: "Refresh outline" }).click();
  await expect(page.getByTestId("status-outline-unavailable")).toBeVisible();
  await expectLocation(page, lessonPath);
  const saved = page.waitForResponse(response => response.url().endsWith("/api/enrollments/7/progress") && response.request().method() === "PATCH");
  releaseSave();
  await saved;

  // Wait for the mutation callback, not merely the HTTP response.
  await expect(page.locator("button:has-text('Waiting for course outline') .animate-spin")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Waiting for course outline" })).toBeDisabled();
  await expectLocation(page, lessonPath);
  await expect(page.getByTestId("button-retry-outline")).toBeEnabled();
  expect(outlineRequests).toBe(2);
});