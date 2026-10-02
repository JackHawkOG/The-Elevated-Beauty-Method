import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";
import {
  courseSwitchEmail, courseSwitchPrivateMetadata, courseSwitchTitle,
  newCourseSwitchTag, requireAuditDevelopment,
} from "./radiant-audit-fixtures";

// Called by the live suite, never by the isolated/mock-Clerk suite.
export async function checkLessonAccountSwitch(page: Page) {
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = newCourseSwitchTag();
  const emails = [courseSwitchEmail("a", tag), courseSwitchEmail("b", tag)];
  const titles = [courseSwitchTitle(tag), `Course-switch member B check ${tag}`];
  const created: string[] = [];
  const courseIds: number[] = [];
  const lessonIds: number[] = [];
  let categoryId: number | undefined;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const requested = new Promise<void>(resolve => { captured = resolve; });
  let held = false;
  let delayed: Promise<void> | undefined;
  const [{ db, categoriesTable, coursesTable, lessonsTable, enrollmentsTable, lessonCompletionsTable }, { and, eq, inArray }] =
    await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);

  try {
    for (const email of emails) {
      const user = await client.users.createUser({
        emailAddress: [email], skipPasswordRequirement: true,
        privateMetadata: courseSwitchPrivateMetadata,
      });
      created.push(user.id);
    }
    await setupClerkTestingToken({ page });
    await page.goto("/radiant-audit");
    await clerk.signIn({ page, emailAddress: emails[0] });
    const [category] = await db.insert(categoriesTable).values({
      name: titles[0], slug: `course-switch-${tag}`,
    }).returning();
    categoryId = category.id;
    const fixtureLessons: Array<Array<{ id: number; title: string }>> = [];
    for (const [index, title] of titles.entries()) {
      const [course] = await db.insert(coursesTable).values({
        title, description: title, categoryId, instructorName: "Test learner",
        accessTier: "Free", publishedAt: new Date(),
      }).returning();
      courseIds.push(course.id);
      const lessons = await db.insert(lessonsTable).values(
        Array.from({ length: index === 0 ? 2 : 3 }, (_, sortOrder) => ({
          courseId: course.id, title: `${title} lesson ${sortOrder + 1}`,
          sortOrder, publishedAt: new Date(),
        })),
      ).returning();
      fixtureLessons.push(lessons);
      lessonIds.push(...lessons.map(lesson => lesson.id));
      await db.insert(enrollmentsTable).values({
        userId: created[index], courseId: course.id, completedLessons: index + 1,
        lastLessonId: lessons[index].id,
      });
      await db.insert(lessonCompletionsTable).values(lessons.slice(0, index + 1).map(lesson => ({
        userId: created[index], lessonId: lesson.id,
      })));
    }
    const [aLessons, bLessons] = fixtureLessons;
    const aPath = `/courses/${courseIds[0]}/lessons/${aLessons[0].id}`;
    const bPath = `/courses/${courseIds[1]}/lessons/${bLessons[1].id}`;
    const bNextPath = `/courses/${courseIds[1]}/lessons/${bLessons[2].id}`;
    const navigateInApp = async (path: string) => {
      // Wouter subscribes to pushState. Keep the document/query client alive:
      // a full page.goto here would discard the cache race being checked.
      await page.evaluate(path => window.history.pushState(null, "", path), path);
      await expect(page).toHaveURL(path);
    };

    // Capture a real browser-authenticated response: route.fetch can lose Clerk
    // authentication. Both fixtures are published, but completion is private.
    const aResponse = await page.evaluate(async () => {
      const response = await fetch("/api/enrollments");
      return { status: response.status, body: await response.text() };
    });
    expect(aResponse.status).toBe(200);
    expect(JSON.parse(aResponse.body)).toContainEqual(expect.objectContaining({
      courseId: courseIds[0], completedLessonIds: [aLessons[0].id],
    }));
    await page.goto(aPath);
    await expect(page.getByRole("button", { name: "Completed · Continue", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await expect(page.locator('[aria-label="Completed"]')).toHaveCount(1);

    await page.goto("/radiant-audit");
    await page.route("**/api/enrollments", async route => {
      if (held || route.request().method() !== "GET" ||
          new URL(route.request().url()).pathname !== "/api/enrollments") {
        return route.continue();
      }
      held = true;
      delayed = (async () => {
        captured();
        await released;
        // Cancellation of the former member's request is safe too.
        await route.fulfill({ status: 200, contentType: "application/json", body: aResponse.body }).catch(error => {
          if (!/aborted|closed|cancelled|canceled|intercept/i.test(String(error))) throw error;
        });
      })();
      await delayed;
    });
    await page.goto(aPath, { waitUntil: "domcontentloaded" });
    await requested;
    expect(held).toBe(true);
    await clerk.signOut({ page });
    await clerk.signIn({ page, emailAddress: emails[1] });
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    const bResponse = await page.evaluate(async () => {
      const response = await fetch("/api/enrollments");
      return { status: response.status, body: await response.json() };
    });
    expect(bResponse.status).toBe(200);
    expect(bResponse.body).toContainEqual(expect.objectContaining({
      courseId: courseIds[1], completedLessonIds: bLessons.slice(0, 2).map(lesson => lesson.id),
    }));
    expect(bResponse.body).not.toContainEqual(expect.objectContaining({ courseId: courseIds[0] }));

    // Observe transient renders as well as final assertions. Titles/content
    // are public; A's checkmark and continuation state are not.
    const watch = ({ aPath, bPath, bNextPath }: { aPath: string; bPath: string; bNextPath: string }) => {
      const check = () => {
        const path = window.location.pathname;
        const labels = [...document.querySelectorAll("button")].map(button => button.textContent?.trim());
        const marks = document.querySelectorAll('[aria-label="Completed"]').length;
        if (path === aPath && (marks > 0 || labels.includes("Completed · Continue") || labels.includes("Continue"))) {
          sessionStorage.setItem("lesson-switch-private-progress", "true");
        }
        // Only judge loaded lesson controls, not a legitimate loading skeleton.
        if ((path === bPath || path === bNextPath) && labels.some(label =>
          ["Mark Complete", "Completed · Continue"].includes(label ?? ""))) {
          if (marks !== 2 || (path === bPath && !labels.includes("Completed · Continue")) ||
              (path === bNextPath && !labels.includes("Finish Course"))) {
            sessionStorage.setItem("lesson-switch-lost-own-progress", "true");
          }
        }
      };
      new MutationObserver(check).observe(document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true,
      });
      check();
    };
    await page.addInitScript(watch, { aPath, bPath, bNextPath });
    await page.evaluate(watch, { aPath, bPath, bNextPath });

    const checkUncompleted = async () => {
      await expect(page.getByRole("button", { name: "Mark Complete", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Complete & Continue", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Completed · Continue", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
      await expect(page.locator('[aria-label="Completed"]')).toHaveCount(0);
    };
    const checkOwnCompleted = async () => {
      await expect(page.getByRole("button", { name: "Completed · Continue", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
      await expect(page.locator('[aria-label="Completed"]')).toHaveCount(2);
    };
    await navigateInApp(aPath);
    await checkUncompleted();
    await navigateInApp(bPath);
    await checkOwnCompleted();
    release();
    await delayed;
    await page.waitForTimeout(250); // Let the released response settle and paint.
    await checkOwnCompleted();

    // Continue is navigation only for B's completed lesson; it must lead to
    // B's uncompleted final lesson, not A's next lesson or a false course end.
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(bNextPath);
    await expect(page.getByRole("button", { name: "Mark Complete", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Finish Course", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Return to Course", exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-label="Completed"]')).toHaveCount(2);
    await page.getByRole("link", { name: "Previous Lesson", exact: true }).click();
    await expect(page).toHaveURL(bPath);
    await checkOwnCompleted();
    await page.getByRole("link", { name: "Course Overview", exact: true }).click();
    await expect(page).toHaveURL(`/courses/${courseIds[1]}`);
    await expect(page.getByRole("link", { name: "Continue Learning" })).toHaveAttribute("href", bNextPath);
    await page.getByRole("link", { name: "Continue Learning" }).click();
    await expect(page).toHaveURL(bNextPath);
    await expect(page.getByRole("button", { name: "Finish Course", exact: true })).toBeEnabled();

    await navigateInApp(aPath);
    await checkUncompleted();
    await page.getByRole("link", { name: "Course Overview", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enroll Now for Free", exact: true })).toBeEnabled();
    await expect(page.getByRole("link", { name: "Continue Learning" })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("lesson-switch-private-progress"))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("lesson-switch-lost-own-progress"))).toBeNull();
  } finally {
    release();
    // Stop browser effects before deleting rows, including on assertion failure.
    await page.close();
    await delayed;
    requireAuditDevelopment();
    try {
      await db.transaction(async tx => {
        if (lessonIds.length && created.length) await tx.delete(lessonCompletionsTable).where(
          and(inArray(lessonCompletionsTable.userId, created), inArray(lessonCompletionsTable.lessonId, lessonIds)),
        );
        if (courseIds.length && created.length) await tx.delete(enrollmentsTable).where(
          and(inArray(enrollmentsTable.userId, created), inArray(enrollmentsTable.courseId, courseIds)),
        );
        if (lessonIds.length) await tx.delete(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
        if (courseIds.length) await tx.delete(coursesTable).where(inArray(coursesTable.id, courseIds));
        if (categoryId !== undefined) await tx.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
      });
    } finally {
      // Remove only identities whose IDs were returned by this run's creation.
      // Attempt both deletions even when one Clerk request fails.
      const results = await Promise.allSettled(created.map(async id => {
        const user = await client.users.getUser(id);
        if (user.privateMetadata.courseSwitchLiveFixture !== courseSwitchPrivateMetadata.courseSwitchLiveFixture ||
            user.emailAddresses.length !== 1 || !emails.includes(user.emailAddresses[0].emailAddress)) {
          throw new Error("Refusing to delete a changed lesson-switch fixture identity");
        }
        await cleanLessonSwitchMember(id);
        await client.users.deleteUser(id);
      }));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Lesson-switch fixture cleanup failed");
    }
  }
}

async function cleanLessonSwitchMember(id: string) {
  requireAuditDevelopment();
  const [{ db, usersTable }, { eq }] = await Promise.all([
    import("../../../lib/db/src/index"), import("drizzle-orm"),
  ]);
  await db.delete(usersTable).where(eq(usersTable.clerkId, id));
}