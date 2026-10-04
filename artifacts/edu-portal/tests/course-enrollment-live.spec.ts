import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import {
  courseSwitchEmail, courseSwitchPrivateMetadata, courseSwitchTitle,
  newCourseSwitchTag, requireAuditDevelopment,
} from "./radiant-audit-fixtures";
import { cleanupEnrollmentReplyFixture } from "./course-enrollment-live-cleanup";
import { runWithCleanup } from "../../api-server/src/routes/member-progress-browser-cleanup";

for (const entry of ["list", "detail"] as const) {
  test(`${entry}: a real member recovers a committed enrollment after its reply is lost`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    requireAuditDevelopment();
    await clerkSetup();
    const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    const tag = newCourseSwitchTag();
    const email = courseSwitchEmail("a", tag);
    const title = courseSwitchTitle(tag);
    const [{ db, categoriesTable, coursesTable, lessonsTable, enrollmentsTable, activityTable, usersTable }, { and, eq }] =
      await Promise.all([import("../../../lib/db/src/index"), import("drizzle-orm")]);
    let userId: string | undefined;
    let category: typeof categoriesTable.$inferSelect | undefined;
    let course: typeof coursesTable.$inferSelect | undefined;
    let lessons: Array<typeof lessonsTable.$inferSelect> = [];
    let member: typeof usersTable.$inferSelect | undefined;
    const originalPageUrl = () => `/courses/${course!.id}`;
    await runWithCleanup(async () => {
      const user = await client.users.createUser({
        emailAddress: [email], skipPasswordRequirement: true,
        privateMetadata: courseSwitchPrivateMetadata,
      });
      userId = user.id;
      await setupClerkTestingToken({ page });
      await page.goto("/radiant-audit");
      await clerk.signIn({ page, emailAddress: email });
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
      [member] = await db.select().from(usersTable).where(eq(usersTable.clerkId, user.id));
      expect(member).toMatchObject({ email, membershipTier: "Free", displayName: "New Learner" });
      [category] = await db.insert(categoriesTable).values({
        name: title, slug: `course-switch-${tag}`,
      }).returning();
      [course] = await db.insert(coursesTable).values({
        title, description: title, categoryId: category.id, instructorName: "Test learner",
        accessTier: "Free", publishedAt: new Date(),
      }).returning();
      lessons = await db.insert(lessonsTable).values([0, 1].map(sortOrder => ({
        courseId: course!.id, title: `${title} lesson ${sortOrder + 1}`,
        sortOrder, publishedAt: new Date(),
      }))).returning();

      const enrollmentRows = () => db.select().from(enrollmentsTable).where(and(
        eq(enrollmentsTable.userId, user.id), eq(enrollmentsTable.courseId, course!.id),
      ));
      const activityRows = () => db.select().from(activityTable).where(eq(activityTable.entityTitle, title));
      expect(await enrollmentRows()).toHaveLength(0);
      expect(await activityRows()).toHaveLength(0);
      // Verify real authenticated GET before injection, not a mocked auth hook.
      const before = await page.evaluate(async () => {
        const response = await fetch("/api/enrollments");
        return { status: response.status, data: await response.json() };
      });
      expect(before.status).toBe(200);
      expect(before.data).toEqual([]);

      await page.goto(entry === "list" ? "/courses" : originalPageUrl());
      if (entry === "list") {
        await page.getByPlaceholder("Search pathways...").fill(title);
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Enroll Now for Free", exact: true })).toBeEnabled();
        await expect(page.getByRole("link", { name: "Start Course", exact: true })).toHaveCount(0);
      }

      // Keep Clerk's original fetch (and its session headers) intact. Discard
      // exactly one POST response only AFTER consuming the real successful reply.
      // No route.fetch replay, API mock, synthetic success, or server fault flag.
      const documentId = await page.evaluate(courseId => {
        const state = window as unknown as {
          enrollmentReplyCheck: {
            documentId: string; posts: number; dropped: number; status?: number;
            committedCourseId?: number; recoveryReads: number; failureToasts: string[];
          };
        };
        const evidence: typeof state.enrollmentReplyCheck = state.enrollmentReplyCheck = {
          documentId: crypto.randomUUID(), posts: 0, dropped: 0,
          recoveryReads: 0, failureToasts: [],
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const input = args[0];
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const method = (args[1]?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          const isEnrollments = url.pathname === "/api/enrollments";
          const targetPost = isEnrollments && method === "POST" &&
            typeof args[1]?.body === "string" && JSON.parse(args[1].body).courseId === courseId;
          if (targetPost) evidence.posts++;
          if (isEnrollments && method === "GET" && evidence.dropped) evidence.recoveryReads++;
          const response = await originalFetch(...args);
          if (targetPost && !evidence.dropped && response.ok) {
            const body = await response.clone().json();
            evidence.status = response.status;
            evidence.committedCourseId = body.courseId;
            evidence.dropped++;
            throw new TypeError("Injected loss of committed enrollment response");
          }
          return response;
        };
        const failureText = /Enrollment failed|Enrollment not confirmed|Your enrollment wasn't found/i;
        const observe = () => {
          for (const node of document.querySelectorAll('[role="status"], [role="alert"], .destructive[data-state="open"]')) {
            const text = node.textContent ?? "";
            if (failureText.test(text) || node.classList.contains("destructive")) evidence.failureToasts.push(text);
          }
        };
        new MutationObserver(observe).observe(document.documentElement, {
          childList: true, subtree: true, characterData: true,
        });
        observe();
        return evidence.documentId;
      }, course.id);
      if (entry === "list") {
        const card = page.locator("a", { has: page.getByRole("heading", { name: title, exact: true }) });
        await card.getByRole("button", { name: "Access", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Enroll Now for Free", exact: true }).click();
      }
      await expect(page).toHaveURL(originalPageUrl());
      await expect(page.getByRole("link", { name: "Start Course", exact: true })).toBeVisible();
      await expect(page.getByText("Enrolled successfully", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Enroll Now for Free", exact: true })).toHaveCount(0);

      const rows = await enrollmentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: user.id, courseId: course.id, completedLessons: 0, lastLessonId: null });
      const activity = await activityRows();
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ type: "enrollment", actorName: member!.displayName, entityTitle: title });

      await page.getByRole("link", { name: "Start Course", exact: true }).click();
      await expect(page).toHaveURL(`/courses/${course.id}/lessons/${lessons[0].id}`);
      // The lesson title is repeated in the banner and lesson content.
      await expect(page.getByRole("heading", { name: lessons[0].title, exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Mark Complete", exact: true })).toBeEnabled();
      await expect(page.getByRole("link", { name: "Course Overview", exact: true })).toBeVisible();
      const evidence = await page.evaluate(() =>
        (window as unknown as { enrollmentReplyCheck: {
          documentId: string; posts: number; dropped: number; status?: number;
          committedCourseId?: number; recoveryReads: number; failureToasts: string[];
        } }).enrollmentReplyCheck,
      );
      expect(evidence).toMatchObject({
        documentId, posts: 1, dropped: 1, status: 201,
        committedCourseId: course.id, failureToasts: [],
      });
      expect(evidence.recoveryReads).toBeGreaterThan(0);
      expect(await enrollmentRows()).toHaveLength(1);
      expect(await activityRows()).toHaveLength(1);
      await testInfo.attach(`recovered-${entry}-lesson`, {
        body: await page.screenshot(), contentType: "image/png",
      });
    }, () => [
      { name: "Close browser before cleanup", run: () => page.close() },
      { name: "Remove only unchanged marked enrollment fixtures", run: async () => {
        if (userId) await cleanupEnrollmentReplyFixture({
          client: client.users, db, userId, email, title, category, course, lessons, member,
        });
      } },
    ]);
  });
}