import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { chromium, expect as browserExpect, type BrowserContext, type Page } from "@playwright/test";
import { clerkClient } from "@clerk/express";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  activityTable, categoriesTable, coursesTable, db, enrollmentsTable, lessonCompletionsTable,
  lessonsTable, pool, usersTable,
} from "@workspace/db";
import { progressBrowserEnvironment } from "./member-progress-browser-environment";

// This intentionally goes through the running web and API workflows, not a
// mocked auth router. Run separately from the fast progress suite.
test("Clerk members retain progress after reload; Free members cannot access it", async () => {
  const target = new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGPORT || !process.env.PGDATABASE ||
      target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE) {
    throw new Error("Browser progress check requires the workspace development database URL");
  }
  const run = randomUUID();
  const identities: string[] = [];
  const contexts: BrowserContext[] = [];
  const names = [`Progress Elevated ${run}`, `Progress Free ${run}`];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let fixtureCourseId: number | undefined;
  let fixtureCategoryId: number | undefined;

  async function api(page: Page, path: string, method = "GET", body?: object) {
    return page.evaluate(async ({ path, method, body }): Promise<{ status: number; data: any }> => {
      const response = await fetch(`/api${path}`, {
        method,
        credentials: "same-origin",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }, { path, method, body });
  }

  async function signIn(identity: string) {
    const context = await browser!.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${base}/sign-in`);
    await page.waitForFunction(() => Boolean((globalThis as any).Clerk?.loaded));
    const signInToken = await clerkClient.signInTokens.createSignInToken({
      userId: identity, expiresInSeconds: 120,
    });
    await page.evaluate(async (ticket) => {
      const clerk = (globalThis as any).Clerk;
      const result = await clerk.client.signIn.create({ strategy: "ticket", ticket });
      if (!result.createdSessionId) throw new Error("Clerk did not create a session");
      await clerk.setActive({ session: result.createdSessionId });
    }, signInToken.token);
    // A successful ticket sign-in consumes the token. Failed tickets expire
    // in two minutes and the disposable Clerk identity is deleted below.
    await page.goto(`${base}/dashboard`);
    await expect.poll(async () => (await api(page, "/users/me")).status).toBe(200);
    return page;
  }
    let [course] = await db.select().from(coursesTable).where(and(
      eq(coursesTable.title, "The Beauty Mindset Accelerator"),
      eq(coursesTable.accessTier, "Elevated"),
      isNotNull(coursesTable.publishedAt),
    )).limit(1);
    let lessons = course ? await db.select().from(lessonsTable).where(and(
      eq(lessonsTable.courseId, course.id), isNotNull(lessonsTable.publishedAt),
    )).orderBy(lessonsTable.sortOrder) : [];
    if (!course || lessons.length !== 4) {
      if (course) throw new Error("Published Accelerator must have four lessons");
      // Some development DBs have only an unapproved draft. A disposable
      // published fixture exercises the same real routes without approving it.
      const [category] = await db.insert(categoriesTable).values({
        name: `Browser progress ${run}`, slug: `browser-progress-${run}`,
      }).returning();
      fixtureCategoryId = category.id;
      [course] = await db.insert(coursesTable).values({
        title: "The Beauty Mindset Accelerator", description: "Temporary browser progress check",
        categoryId: category.id, instructorName: "Progress Check",
        accessTier: "Elevated", publishedAt: new Date(),
      }).returning();
      fixtureCourseId = course.id;
      lessons = await db.insert(lessonsTable).values([1, 2, 3, 4].map(sortOrder => ({
        courseId: course.id, title: `Browser progress module ${sortOrder} ${run}`,
        content: `Private lesson for browser check ${sortOrder} ${run}`,
        sortOrder, publishedAt: new Date(),
      }))).returning();
    }

    for (const [index, name] of names.entries()) {
      const user = await clerkClient.users.createUser({
        emailAddress: [`progress-${index}-${run}@example.com`],
        firstName: name,
        password: `A!${randomUUID()}z9`,
      });
      identities.push(user.id);
    }
    // First request JIT-provisions a real DB member from the Clerk identity.
    const elevated = await signIn(identities[0]);
    expect((await api(elevated, "/users/me")).data.membershipTier).toBe("Free");
    await db.update(usersTable).set({ membershipTier: "Elevated" })
      .where(eq(usersTable.clerkId, identities[0]));
    await elevated.reload();
    await browserExpect(elevated.getByTestId("text-accelerator-progress"))
      .toHaveText("Enrollment not started");

    await elevated.getByTestId("link-accelerator-primary").click();
    await browserExpect(elevated.getByRole("button", { name: "Unlock with Elevated" }).first()).toBeVisible();
    await elevated.getByRole("button", { name: "Unlock with Elevated" }).first().click();
    await browserExpect(elevated.getByRole("link", { name: /Start Course/ })).toBeVisible();
    await elevated.goto(`${base}/dashboard`);
    await browserExpect(elevated.getByTestId("text-accelerator-progress")).toHaveText("0 of 4 modules complete");

    for (const [index, lesson] of lessons.slice(0, 2).entries()) {
      await elevated.getByTestId(`link-accelerator-lesson-${lesson.id}`).click();
      await browserExpect(elevated.getByRole("heading", { name: lesson.title }).last()).toBeVisible();
      await elevated.getByRole("button", { name: "Mark Complete" }).click();
      await expect.poll(async () => {
        const response = await api(elevated, "/enrollments");
        return response.data.find((row: { courseId: number }) => row.courseId === course.id)?.completedLessons;
      }).toBe(index + 1);
      await elevated.goto(`${base}/dashboard`);
      await browserExpect(elevated.getByTestId("text-accelerator-progress"))
        .toHaveText(`${index + 1} of 4 modules complete`);
    }

    await elevated.reload();
    await browserExpect(elevated.getByTestId("text-accelerator-progress")).toHaveText("2 of 4 modules complete");
    await browserExpect(elevated.getByRole("progressbar", { name: "Accelerator progress" }))
      .toHaveAttribute("aria-valuenow", "50");
    for (const lesson of lessons.slice(0, 2)) {
      await browserExpect(elevated.getByTestId(`status-accelerator-module-${lesson.id}`)).toHaveText("Complete");
    }
    await elevated.getByTestId(`link-accelerator-lesson-${lessons[0].id}`).click();
    await elevated.reload();
    await browserExpect(elevated.getByRole("button", { name: "Completed · Continue" })).toBeVisible();

    const free = await signIn(identities[1]);
    expect((await api(free, "/users/me")).data.membershipTier).toBe("Free");
    const lessonPath = `/lessons/${lessons[0].id}`;

  const { base, chromiumPath } = progressBrowserEnvironment();
