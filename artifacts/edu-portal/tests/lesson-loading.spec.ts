import { expect, test, type Page } from "@playwright/test";

const lesson = { id: 42, courseId: 7, title: "Cached lesson title", content: "Previously loaded lesson text", videoUrl: null };

async function stubRelatedRequests(page: Page) {
  await page.route("**/api/courses/7", route => route.fulfill({ json: { id: 7, title: "Test course" } }));
  await page.route("**/api/courses/7/lessons", route => route.fulfill({ json: [lesson] }));
  await page.route("**/api/enrollments", route => route.fulfill({ json: [] }));
}

async function expectNoLessonControls(page: Page) {
  await expect(page.getByText(lesson.content)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Mark Complete|Complete & Continue|Finish Course|Return to Course/ })).toHaveCount(0);
}

for (const [status, heading] of [[404, "Lesson not found"], [403, "Lesson access required"]] as const) {
  test(`${status} retains its distinct lesson state`, async ({ page }) => {
    await stubRelatedRequests(page);
    await page.route("**/api/lessons/42", route => route.fulfill({ status, json: { message: heading } }));
    await page.goto("/tests/lesson-harness.html");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lesson could not be loaded" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expectNoLessonControls(page);
  });
}

for (const failure of ["server", "network"] as const) {
  test(`${failure} failure after a cached lesson hides content and retry recovers`, async ({ page }) => {
    await stubRelatedRequests(page);
    let requests = 0;
    await page.route("**/api/lessons/42", route => {
      requests++;
      if (requests === 1 || requests === 3) {
        return route.fulfill({ json: lesson });
      }
      return failure === "server"
        ? route.fulfill({ status: 503, json: { message: "Unavailable" } })
        : route.abort("failed");
    });

    await page.goto("/tests/lesson-harness.html");
    await expect(page.getByText(lesson.content)).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark Complete" })).toBeVisible();
    await page.getByRole("button", { name: "Refresh lesson" }).click();

    await expect(page.getByTestId("status-lesson-load-error")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lesson not found" })).toHaveCount(0);
    await expectNoLessonControls(page);
    expect(requests).toBe(2);

    await page.getByTestId("button-retry-lesson").click();
    await expect(page.getByText(lesson.content)).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark Complete" })).toBeVisible();
    await expect(page.getByTestId("status-lesson-load-error")).toHaveCount(0);
    expect(requests).toBe(3);
  });
}