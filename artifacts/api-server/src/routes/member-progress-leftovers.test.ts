import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityTable, categoriesTable, coursesTable, db, enrollmentsTable,
  lessonCompletionsTable, lessonsTable, pool, usersTable, type PoolClient,
} from "@workspace/db";
import { expect, test, vi } from "vitest";
import { activityRun, categoryRun, confirmedRun, eligibleRun, identityRun, staleCandidates, type Candidate } from "./member-progress-leftovers";
import { inspectProgressLeftovers, progressLeftoverArgs, runProgressLeftovers } from "./member-progress-leftovers-cli";
import { requireDevelopmentDatabase } from "./test-development-database";

const run = "12345678-1234-1234-1234-123456789abc";
const now = new Date("2026-09-27T12:00:00Z");
const old = new Date("2026-09-27T10:00:00Z");
const candidate = (kind: Candidate["kind"], createdAt = old): Candidate => ({
  kind, id: "1", run, createdAt,
  marker: kind === "category" ? `browser-progress-${run}` :
    kind === "activity" ? `Progress Elevated ${run}` : `progress-0-${run}@example.com`,
  name: kind === "category" ? `Browser progress ${run}` :
    kind === "activity" ? "The Beauty Mindset Accelerator" : `Progress Elevated ${run}`,
  ...(kind === "activity" ? { type: "enrollment", description: "enrolled in a course" } : {}),
});

test("only exact fixture markers are accepted", () => {
  expect(categoryRun(`browser-progress-${run}`, `Browser progress ${run}`)).toBe(run);
  expect(identityRun(`progress-1-${run}@example.com`, `Progress Free ${run}`)).toBe(run);
  expect(categoryRun(`browser-progress-${run}`, "Real category")).toBeUndefined();
  expect(identityRun(`progress-0-${run}@example.com`, "Real person")).toBeUndefined();
  expect(identityRun(`progress-2-${run}@example.com`, `Progress Free ${run}`)).toBeUndefined();
  expect(categoryRun(`browser-progress-${run}-copy`, `Browser progress ${run}`)).toBeUndefined();
  expect(activityRun(`Progress Elevated ${run}`, "The Beauty Mindset Accelerator", "enrollment", "enrolled in a course")).toBe(run);
  for (const [actor, title, type, description] of [
    [`Progress Elevated ${run} copy`, "The Beauty Mindset Accelerator", "enrollment", "enrolled in a course"],
    [`Progress Free ${run}`, "The Beauty Mindset Accelerator", "enrollment", "enrolled in a course"],
    [`Progress Elevated ${run}`, "Another course", "enrollment", "enrolled in a course"],
    [`Progress Elevated ${run}`, "The Beauty Mindset Accelerator", "announcement", "enrolled in a course"],
    [`Progress Elevated ${run}`, "The Beauty Mindset Accelerator", "enrollment", "another action"],
  ]) {
    expect(activityRun(actor, title, type, description)).toBeUndefined();
  }
});

test("dry-run and deletion eligibility exclude fresh and unrelated records", () => {
  expect(staleCandidates([
    candidate("clerk"), candidate("member"), candidate("category"), candidate("activity"),
    candidate("clerk", new Date("2026-09-27T11:30:00Z")),
    candidate("activity", new Date("2026-09-27T11:30:00Z")),
    { ...candidate("activity"), name: "Another course" },
    { ...candidate("activity"), type: "announcement" },
    { ...candidate("activity"), description: "different action" },
    { ...candidate("activity"), marker: "Someone else" },
    { ...candidate("member"), run: "87654321-1234-1234-1234-123456789abc" },
    { ...candidate("category"), name: "My curriculum" },
  ], now).map(c => c.kind)).toEqual(["clerk", "member", "category", "activity"]);
  expect(() => staleCandidates([candidate("clerk")], now, 0)).toThrow(/Minimum age/);
  expect(() => eligibleRun([candidate("clerk"), candidate("category", new Date("2026-09-27T11:30:00Z"))], now, run))
    .toThrow(/fully stale/);
  expect(() => eligibleRun([candidate("member"), candidate("activity", new Date("2026-09-27T11:30:00Z"))], now, run))
    .toThrow(/fully stale/);
  expect(() => eligibleRun([], now, run)).toThrow(/fully stale/);
  expect(eligibleRun([candidate("clerk"), candidate("member")], now, run)).toHaveLength(2);
  expect(eligibleRun([candidate("activity")], now, run)).toEqual([candidate("activity")]);
  expect(eligibleRun([candidate("activity"), candidate("activity", new Date("2026-09-27T11:30:00Z"))], now, run))
    .toEqual([candidate("activity")]);
  expect(() => eligibleRun([candidate("activity", new Date("2026-09-27T11:30:00Z"))], now, run))
    .toThrow(/fully stale/);
});

test("deletion requires the same exact run ID twice", () => {
  expect(confirmedRun([])).toBeUndefined();
  expect(confirmedRun(["--delete", run, run])).toBe(run);
  expect(() => confirmedRun(["--delete", run])).toThrow();
  expect(() => confirmedRun(["--delete", run, "87654321-1234-1234-1234-123456789abc"])).toThrow();
  expect(progressLeftoverArgs(["--activity-only"])).toEqual({ run: undefined, mode: "activity-only" });
  expect(progressLeftoverArgs(["--activity-only", "--delete", run, run])).toEqual({ run, mode: "activity-only" });
  expect(() => progressLeftoverArgs(["--activity-only", "--delete", run])).toThrow();
  expect(() => progressLeftoverArgs(["--activity-only", "--delete", run, `${run}-other`])).toThrow();
  expect(() => progressLeftoverArgs(["--unknown"])).toThrow();
});

test("database dry run and confirmed cleanup isolate stale activity-only progress entries", async () => {
  requireDevelopmentDatabase();
  const fixtureRun = randomUUID();
  const otherRun = randomUUID();
  const actor = `Progress Elevated ${fixtureRun}`;
  const title = "The Beauty Mindset Accelerator";
  const description = "enrolled in a course";
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const recent = new Date();
  const createdIds: number[] = [];
  try {
    const fixtures = [
      { actorName: actor, entityTitle: title, type: "enrollment", description, createdAt: old },
      { actorName: actor, entityTitle: title, type: "enrollment", description, createdAt: recent },
      { actorName: `${actor} copy`, entityTitle: title, type: "enrollment", description, createdAt: old },
      { actorName: actor, entityTitle: "Another course", type: "enrollment", description, createdAt: old },
      { actorName: actor, entityTitle: title, type: "announcement", description, createdAt: old },
      { actorName: actor, entityTitle: title, type: "enrollment", description: "another action", createdAt: old },
      { actorName: `Progress Elevated ${otherRun}`, entityTitle: title, type: "enrollment", description, createdAt: old },
    ];
    // Track each insert immediately so cleanup still works if a later insert fails.
    for (const fixture of fixtures) {
      const [row] = await db.insert(activityTable).values(fixture).returning({ id: activityTable.id });
      createdIds.push(row.id);
    }
    const output: string[] = [];
    const noClerk = async (): Promise<never> => { throw new Error("Clerk is unavailable"); };
    const withoutClerkConfig = {
      ...process.env, CLERK_SECRET_KEY: undefined, CLERK_PUBLISHABLE_KEY: undefined,
      VITE_CLERK_PUBLISHABLE_KEY: undefined, REPLIT_DEV_DOMAIN: undefined,
      CHROMIUM_PATH: "/nonexistent/chromium",
    };
    await runProgressLeftovers(["--activity-only"], noClerk, message => output.push(message), withoutClerkConfig);
    const report = JSON.parse(output[0]) as { candidates: Array<{ kind: string; id: string; run: string }> };
    expect(report.candidates.filter(entry => createdIds.includes(Number(entry.id))))
      .toEqual([
        { kind: "activity", id: String(createdIds[0]), run: fixtureRun,
          createdAt: old.toISOString(), marker: actor, type: "enrollment", description },
        { kind: "activity", id: String(createdIds[6]), run: otherRun,
          createdAt: old.toISOString(), marker: `Progress Elevated ${otherRun}`, type: "enrollment", description },
      ]);
    expect(output.at(-2)).toMatch(/Dry run only; nothing deleted/);
    expect(output.at(-1)).toMatch(/Clerk identities and curriculum were not checked/);
    expect((await db.select({ id: activityTable.id }).from(activityTable)
      .where(inArray(activityTable.id, createdIds))).map(row => row.id)).toEqual(createdIds);

    await runProgressLeftovers(
      ["--activity-only", "--delete", fixtureRun, fixtureRun], noClerk, () => {}, withoutClerkConfig,
    );
    expect((await db.select({ id: activityTable.id }).from(activityTable)
      .where(inArray(activityTable.id, createdIds))).map(row => row.id))
      .toEqual(createdIds.slice(1));
    // A second attempt cannot remove the recent exact match.
    await expect(runProgressLeftovers(
      ["--activity-only", "--delete", fixtureRun, fixtureRun], noClerk, () => {}, withoutClerkConfig,
    )).rejects.toThrow(/fully stale/);
    await expect(runProgressLeftovers(
      [], noClerk, () => {}, {
        ...process.env, CLERK_SECRET_KEY: "sk_test_mock", CLERK_PUBLISHABLE_KEY: "pk_test_mock",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_mock", REPLIT_DEV_DOMAIN: "example.replit.dev",
        CHROMIUM_PATH: process.execPath,
      },
    )).rejects.toThrow(/Clerk is unavailable/);
  } finally {
    if (createdIds.length) {
      await db.delete(activityTable).where(inArray(activityTable.id, createdIds));
    }
  }
});

test("activity-only confirmed cleanup leaves matching members and curriculum unchanged", async () => {
  requireDevelopmentDatabase();
  const fixtureRun = randomUUID();
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const clerkId = `progress-activity-only-${fixtureRun}`;
  const actorName = `Progress Elevated ${fixtureRun}`;
  let memberId: number | undefined;
  let categoryId: number | undefined;
  let courseId: number | undefined;
  let lessonId: number | undefined;
  let enrollmentId: number | undefined;
  let completionCreated = false;
  const activityIds: number[] = [];
  let clerkLoads = 0;
  const unavailableClerk = async (): Promise<never> => {
    clerkLoads++;
    throw new Error("Clerk is unavailable");
  };
  const withoutClerkConfig = {
    ...process.env, CLERK_SECRET_KEY: undefined, CLERK_PUBLISHABLE_KEY: undefined,
    VITE_CLERK_PUBLISHABLE_KEY: undefined, REPLIT_DEV_DOMAIN: undefined,
    CHROMIUM_PATH: "/nonexistent/chromium",
  };
  try {
    // Every non-feed fixture is eligible for full cleanup of this same run.
    // A recent feed row must survive alongside the exact non-feed snapshots.
    const [member] = await db.insert(usersTable).values({
      clerkId, email: `progress-0-${fixtureRun}@example.com`, displayName: actorName, createdAt,
    }).returning();
    memberId = member.id;
    const [category] = await db.insert(categoriesTable).values({
      slug: `browser-progress-${fixtureRun}`, name: `Browser progress ${fixtureRun}`, createdAt,
    }).returning();
    categoryId = category.id;
    const [course] = await db.insert(coursesTable).values({
      categoryId, title: "The Beauty Mindset Accelerator",
      description: "Temporary browser progress check", instructorName: "Progress Check",
      accessTier: "Elevated", createdAt,
    }).returning();
    courseId = course.id;
    const [lesson] = await db.insert(lessonsTable).values({
      courseId, sortOrder: 1, title: `Browser progress module 1 ${fixtureRun}`,
      content: `Private lesson for browser check 1 ${fixtureRun}`, createdAt,
    }).returning();
    lessonId = lesson.id;
    const [enrollment] = await db.insert(enrollmentsTable).values({ userId: clerkId, courseId }).returning();
    enrollmentId = enrollment.id;
    const [completion] = await db.insert(lessonCompletionsTable).values({
      userId: clerkId, lessonId,
    }).returning();
    completionCreated = true;
    for (const timestamp of [createdAt, new Date()]) {
      const [activity] = await db.insert(activityTable).values({
        actorName, entityTitle: course.title, type: "enrollment",
        description: "enrolled in a course", createdAt: timestamp,
      }).returning({ id: activityTable.id });
      activityIds.push(activity.id);
    }
    const [recentActivity] = await db.select().from(activityTable)
      .where(eq(activityTable.id, activityIds[1]));
    const output: string[] = [];
    await runProgressLeftovers(
      ["--activity-only", "--delete", fixtureRun, fixtureRun],
      unavailableClerk, message => output.push(message), withoutClerkConfig,
    );
    expect(clerkLoads).toBe(0);
    expect(output).toEqual([
      `Removed confirmed disposable activity rows for ${fixtureRun}. Clerk identities and curriculum were not checked.`,
    ]);
    expect(await db.select().from(activityTable)
      .where(inArray(activityTable.id, activityIds))).toEqual([recentActivity]);
    expect(await db.select().from(usersTable).where(eq(usersTable.id, member.id))).toEqual([member]);
    expect(await db.select().from(categoriesTable).where(eq(categoriesTable.id, category.id))).toEqual([category]);
    expect(await db.select().from(coursesTable).where(eq(coursesTable.id, course.id))).toEqual([course]);
    expect(await db.select().from(lessonsTable).where(eq(lessonsTable.id, lesson.id))).toEqual([lesson]);
    expect(await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollment.id)))
      .toEqual([enrollment]);
    expect(await db.select().from(lessonCompletionsTable).where(and(
      eq(lessonCompletionsTable.userId, completion.userId),
      eq(lessonCompletionsTable.lessonId, completion.lessonId),
    )))
      .toEqual([completion]);

    // The database-only exception must not allow full confirmed cleanup to
    // bypass the identity provider. No real Clerk users are created or deleted.
    await expect(runProgressLeftovers(
      ["--delete", fixtureRun, fixtureRun], unavailableClerk, () => {}, {
        ...process.env, CLERK_SECRET_KEY: "sk_test_mock", CLERK_PUBLISHABLE_KEY: "pk_test_mock",
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_mock", REPLIT_DEV_DOMAIN: "example.replit.dev",
        CHROMIUM_PATH: process.execPath,
      },
    )).rejects.toThrow(/Clerk is unavailable/);
    expect(clerkLoads).toBe(1);
  } finally {
    // Guarded development DB only; remove only IDs returned by this test's
    // inserts, in dependency order, including when setup fails partway through.
    if (activityIds.length) await db.delete(activityTable).where(inArray(activityTable.id, activityIds));
    if (completionCreated && lessonId !== undefined) await db.delete(lessonCompletionsTable).where(and(
      eq(lessonCompletionsTable.userId, clerkId), eq(lessonCompletionsTable.lessonId, lessonId),
    ));
    if (enrollmentId !== undefined) await db.delete(enrollmentsTable).where(eq(enrollmentsTable.id, enrollmentId));
    if (lessonId !== undefined) await db.delete(lessonsTable).where(eq(lessonsTable.id, lessonId));
    if (courseId !== undefined) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
    if (categoryId !== undefined) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    if (memberId !== undefined) await db.delete(usersTable).where(eq(usersTable.id, memberId));
  }
});

test("database cleanup rolls back every selected feed row if one changes after selection", async () => {
  requireDevelopmentDatabase();
  const fixtureRun = randomUUID();
  const actorName = `Progress Elevated ${fixtureRun}`;
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const description = "enrolled in a course";
  const changedDescription = "edited after inspection";
  const createdIds: number[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const [row] = await db.insert(activityTable).values({
        actorName, entityTitle: "The Beauty Mindset Accelerator",
        type: "enrollment", description, createdAt,
      }).returning({ id: activityTable.id });
      createdIds.push(row.id);
    }
    let changed = false;
    let clerkDeleteCalled = false;
    const output: string[] = [];
    await expect(inspectProgressLeftovers(
      fixtureRun, [],
      async () => { clerkDeleteCalled = true; },
      message => output.push(message),
      async () => {
        // The second row stops matching the selected fixture after inspection.
        // The first delete must be undone when the second guarded delete fails.
        await db.update(activityTable).set({ description: changedDescription })
          .where(eq(activityTable.id, createdIds[1]));
        changed = true;
      },
    )).rejects.toThrow(/Activity changed during cleanup; refusing partial deletion/);
    expect(changed).toBe(true);
    expect(clerkDeleteCalled).toBe(false);
    expect(output).toEqual([]);
    const remaining = await db.select({
      id: activityTable.id, description: activityTable.description,
    }).from(activityTable).where(inArray(activityTable.id, createdIds)).orderBy(activityTable.id);
    expect(remaining).toEqual([
      { id: createdIds[0], description },
      { id: createdIds[1], description: changedDescription },
    ]);
  } finally {
    if (createdIds.length) {
      await db.delete(activityTable).where(inArray(activityTable.id, createdIds));
    }
  }
});

test.each(["changed-email", "changed-name", "unchanged"] as const)(
  "database member cleanup preserves a %s selection before identity deletion",
  async state => {
    requireDevelopmentDatabase();
    const fixtureRun = randomUUID();
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const identities = [0, 1].map(index => ({
      id: `progress-leftovers-${index}-${fixtureRun}`,
      email: `progress-${index}-${fixtureRun}@example.com`,
      name: `Progress ${index === 0 ? "Elevated" : "Free"} ${fixtureRun}`,
      createdAt,
    }));
    const memberIds: string[] = [];
    const activityIds: number[] = [];
    const deletedIdentities: string[] = [];
    const output: string[] = [];
    const changedEmail = `changed-${fixtureRun}@example.com`;
    const changedName = `Renamed member ${fixtureRun}`;
    try {
      for (const identity of identities) {
        const [row] = await db.insert(usersTable).values({
          clerkId: identity.id, email: identity.email, displayName: identity.name, createdAt,
        }).returning({ clerkId: usersTable.clerkId });
        memberIds.push(row.clerkId);
      }
      const [activity] = await db.insert(activityTable).values({
        actorName: identities[0].name, entityTitle: "The Beauty Mindset Accelerator",
        type: "enrollment", description: "enrolled in a course", createdAt,
      }).returning({ id: activityTable.id });
      activityIds.push(activity.id);

      const cleanup = inspectProgressLeftovers(
        fixtureRun, identities,
        async id => { deletedIdentities.push(id); },
        message => output.push(message),
        async () => {
          if (state !== "unchanged") {
            // Change the second selected member so an earlier successful delete
            // must roll back, without ever reaching the identity provider.
            await db.update(usersTable).set(state === "changed-email"
              ? { email: changedEmail } : { displayName: changedName })
              .where(eq(usersTable.clerkId, identities[1].id));
          }
        },
      );
      if (state !== "unchanged") {
        await expect(cleanup).rejects.toThrow(/Member changed during cleanup; refusing partial deletion/);
        expect(deletedIdentities).toEqual([]);
        expect(output).toEqual([]);
        const remaining = await db.select({
          clerkId: usersTable.clerkId, email: usersTable.email, displayName: usersTable.displayName,
        }).from(usersTable).where(inArray(usersTable.clerkId, memberIds)).orderBy(usersTable.id);
        expect(remaining).toEqual([
          { clerkId: identities[0].id, email: identities[0].email, displayName: identities[0].name },
          {
            clerkId: identities[1].id,
            email: state === "changed-email" ? changedEmail : identities[1].email,
            displayName: state === "changed-name" ? changedName : identities[1].name,
          },
        ]);
        expect(await db.select({ id: activityTable.id }).from(activityTable)
          .where(inArray(activityTable.id, activityIds))).toEqual([{ id: activity.id }]);
      } else {
        await cleanup;
        expect(deletedIdentities).toEqual(memberIds);
        expect(output).toEqual([
          `Removed confirmed disposable records for ${fixtureRun}. Re-run dry run to check for remaining Clerk users.`,
        ]);
        expect(await db.select().from(usersTable)
          .where(inArray(usersTable.clerkId, memberIds))).toEqual([]);
        expect(await db.select().from(activityTable)
          .where(inArray(activityTable.id, activityIds))).toEqual([]);
      }
    } finally {
      if (activityIds.length) await db.delete(activityTable).where(inArray(activityTable.id, activityIds));
      if (memberIds.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, memberIds));
    }
  },
);

test.each([
  "category-name", "category-slug", "category-description", "category-icon", "category-created-at",
  "course-title", "course-description", "course-instructor", "course-tier",
  "course-created-at", "course-thumbnail", "lesson-title", "lesson-content",
  "lesson-order", "lesson-created-at", "lesson-video", "added-lesson", "unchanged",
] as const)(
  "database curriculum cleanup guards a %s change after inspection",
  async change => {
    requireDevelopmentDatabase();
    const fixtureRun = randomUUID();
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const identity = {
      id: `progress-curriculum-${fixtureRun}`,
      email: `progress-0-${fixtureRun}@example.com`,
      name: `Progress Elevated ${fixtureRun}`, createdAt,
    };
    let categoryId: number | undefined;
    let courseId: number | undefined;
    const lessonIds: number[] = [];
    const activityIds: number[] = [];
    const deletedIdentities: string[] = [];
    const output: string[] = [];
    try {
      const [member] = await db.insert(usersTable).values({
        clerkId: identity.id, email: identity.email, displayName: identity.name, createdAt,
      }).returning();
      const [category] = await db.insert(categoriesTable).values({
        slug: `browser-progress-${fixtureRun}`, name: `Browser progress ${fixtureRun}`, createdAt,
      }).returning();
      categoryId = category.id;
      const [course] = await db.insert(coursesTable).values({
        categoryId, title: "The Beauty Mindset Accelerator",
        description: "Temporary browser progress check", instructorName: "Progress Check",
        accessTier: "Elevated", createdAt,
      }).returning();
      courseId = course.id;
      for (let sortOrder = 1; sortOrder <= 2; sortOrder++) {
        const [lesson] = await db.insert(lessonsTable).values({
          courseId, sortOrder, title: `Browser progress module ${sortOrder} ${fixtureRun}`,
          content: `Private lesson for browser check ${sortOrder} ${fixtureRun}`, createdAt,
        }).returning();
        lessonIds.push(lesson.id);
      }
      const [enrollment] = await db.insert(enrollmentsTable).values({
        userId: identity.id, courseId,
      }).returning();
      const [completion] = await db.insert(lessonCompletionsTable)
        .values({ userId: identity.id, lessonId: lessonIds[0] }).returning();
      const [activity] = await db.insert(activityTable).values({
        actorName: identity.name, entityTitle: course.title,
        type: "enrollment", description: "enrolled in a course", createdAt,
      }).returning();
      activityIds.push(activity.id);
      let expectedCategory = category;
      let expectedCourse = course;
      let expectedLessons = await db.select().from(lessonsTable)
        .where(eq(lessonsTable.courseId, course.id)).orderBy(lessonsTable.id);
      const cleanup = inspectProgressLeftovers(
        fixtureRun, [identity], async id => { deletedIdentities.push(id); },
        message => output.push(message),
        async () => {
          // Commit through a separate connection after the inspector's snapshot,
          // before its transaction. No real identity-provider users are created.
          const categoryChanges = {
            "category-name": { name: "Real category" },
            "category-slug": { slug: `real-category-${fixtureRun}` },
            "category-description": { description: "Real editorial content" },
            "category-icon": { icon: "GraduationCap" },
            "category-created-at": { createdAt: new Date() },
          };
          const courseChanges = {
            "course-title": { title: "Edited course" },
            "course-description": { description: "Real course content" },
            "course-instructor": { instructorName: "Real instructor" },
            "course-tier": { accessTier: "Free" },
            "course-created-at": { createdAt: new Date() },
            "course-thumbnail": { thumbnailUrl: "https://example.com/edited.png" },
          };
          const lessonChanges = {
            "lesson-title": { title: "Edited lesson" },
            "lesson-content": { content: "Real lesson content" },
            "lesson-order": { sortOrder: 4 },
            "lesson-created-at": { createdAt: new Date() },
            "lesson-video": { videoUrl: "https://example.com/edited.mp4" },
          };
          if (change in categoryChanges) {
            await db.update(categoriesTable).set(categoryChanges[change as keyof typeof categoryChanges])
              .where(eq(categoriesTable.id, category.id));
          } else if (change in courseChanges) {
            await db.update(coursesTable).set(courseChanges[change as keyof typeof courseChanges])
              .where(eq(coursesTable.id, course.id));
          } else if (change in lessonChanges) {
            // Edit the second lesson: the first must not be partially removed.
            await db.update(lessonsTable).set(lessonChanges[change as keyof typeof lessonChanges])
              .where(eq(lessonsTable.id, lessonIds[1]));
          } else if (change === "added-lesson") {
            const [added] = await db.insert(lessonsTable).values({
              courseId: course.id, title: "Real new lesson", content: "New content",
            }).returning();
            lessonIds.push(added.id);
          }
          [expectedCategory] = await db.select().from(categoriesTable)
            .where(eq(categoriesTable.id, category.id));
          [expectedCourse] = await db.select().from(coursesTable).where(eq(coursesTable.id, course.id));
          expectedLessons = await db.select().from(lessonsTable)
            .where(eq(lessonsTable.courseId, course.id)).orderBy(lessonsTable.id);
        },
      );
      if (change !== "unchanged") {
        await expect(cleanup).rejects.toThrow(
          change.startsWith("category-")
            ? /Category changed during cleanup; refusing partial deletion/
            : change.startsWith("course-")
            ? /Course changed during cleanup; refusing partial deletion/
            : /Lessons changed during cleanup; refusing partial deletion/,
        );
        expect(deletedIdentities).toEqual([]);
        expect(output).toEqual([]);
        expect(await db.select().from(coursesTable).where(eq(coursesTable.id, course.id)))
          .toEqual([expectedCourse]);
        expect(await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id))
          .orderBy(lessonsTable.id)).toEqual(expectedLessons);
        expect(await db.select().from(categoriesTable).where(eq(categoriesTable.id, category.id)))
          .toEqual([expectedCategory]);
        expect(await db.select().from(usersTable)
          .where(eq(usersTable.clerkId, identity.id))).toEqual([member]);
        expect(await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollment.id)))
          .toEqual([enrollment]);
        expect(await db.select().from(lessonCompletionsTable)
          .where(eq(lessonCompletionsTable.userId, identity.id))).toEqual([completion]);
        expect(await db.select().from(activityTable).where(eq(activityTable.id, activity.id)))
          .toEqual([activity]);
      } else {
        await cleanup;
        expect(deletedIdentities).toEqual([identity.id]);
        expect(output).toEqual([
          `Removed confirmed disposable records for ${fixtureRun}. Re-run dry run to check for remaining Clerk users.`,
        ]);
        expect(await db.select().from(coursesTable).where(eq(coursesTable.id, course.id))).toEqual([]);
        expect(await db.select().from(lessonsTable).where(inArray(lessonsTable.id, lessonIds))).toEqual([]);
        expect(await db.select().from(categoriesTable).where(eq(categoriesTable.id, category.id))).toEqual([]);
        expect(await db.select().from(usersTable).where(eq(usersTable.clerkId, identity.id))).toEqual([]);
        expect(await db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, enrollment.id))).toEqual([]);
        expect(await db.select().from(lessonCompletionsTable)
          .where(eq(lessonCompletionsTable.userId, identity.id))).toEqual([]);
        expect(await db.select().from(activityTable).where(eq(activityTable.id, activity.id))).toEqual([]);
      }
    } finally {
      // Only IDs from this test's inserts, in dependency order, even on failure.
      if (activityIds.length) await db.delete(activityTable).where(inArray(activityTable.id, activityIds));
      await db.delete(lessonCompletionsTable).where(eq(lessonCompletionsTable.userId, identity.id));
      await db.delete(enrollmentsTable).where(eq(enrollmentsTable.userId, identity.id));
      if (lessonIds.length) await db.delete(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
      if (courseId !== undefined) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
      if (categoryId !== undefined) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
      await db.delete(usersTable).where(eq(usersTable.clerkId, identity.id));
    }
  },
);

test.each(["course-edit", "lesson-edit", "lesson-insert"] as const)(
  "database cleanup blocks a concurrent %s after curriculum snapshot rechecks",
  async change => {
    requireDevelopmentDatabase();
    const fixtureRun = randomUUID();
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    let categoryId: number | undefined;
    let courseId: number | undefined;
    const lessonIds: number[] = [];
    const output: string[] = [];
    let releaseCleanup!: () => void;
    const gate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let reachedDeletion!: () => void;
    const ready = new Promise<void>(resolve => { reachedDeletion = resolve; });
    const bounded = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 8000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const transaction = db.transaction.bind(db);
    let transactionSpy: { mockRestore: () => void } | undefined;
    let cleanup: Promise<void> | undefined;
    let writer: PoolClient | undefined;
    let write: Promise<{ rowCount: number | null; committed: boolean; errorCode?: string }> | undefined;
    let writeSettled = false;
    let cleanupPid: number | undefined;
    let observeBlocking: (() => Promise<boolean>) | undefined;
    try {
      const [category] = await db.insert(categoriesTable).values({
        slug: `browser-progress-${fixtureRun}`, name: `Browser progress ${fixtureRun}`, createdAt,
      }).returning();
      categoryId = category.id;
      const [course] = await db.insert(coursesTable).values({
        categoryId, title: "The Beauty Mindset Accelerator",
        description: "Temporary browser progress check", instructorName: "Progress Check",
        accessTier: "Elevated", createdAt,
      }).returning();
      courseId = course.id;
      const [lesson] = await db.insert(lessonsTable).values({
        courseId, sortOrder: 1, title: `Browser progress module 1 ${fixtureRun}`,
        content: `Private lesson for browser check 1 ${fixtureRun}`, createdAt,
      }).returning();
      lessonIds.push(lesson.id);

      const connection = await pool.connect();
      writer = connection;
      const writerPid = Number((await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '8s'");
      await connection.query("SET LOCAL statement_timeout = '10s'");
      transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) =>
        transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
          cleanupPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
          expect(cleanupPid).not.toBe(writerPid);
          // Observe from the paused cleanup connection itself: this race uses
          // only two connections, not a third administrative polling session.
          observeBlocking = async () => {
            const result = await tx.execute(sql`
              SELECT ${cleanupPid!}::int = ANY(pg_blocking_pids(${writerPid}::int)) AS blocked
            `);
            return result.rows[0].blocked === true;
          };
          const deleteRow = tx.delete.bind(tx);
          let paused = false;
          const deleteSpy = vi.spyOn(tx, "delete").mockImplementation(table => {
            const query = deleteRow(table);
            if (table === lessonsTable && !paused) {
              paused = true;
              const execute = query.execute.bind(query);
              vi.spyOn(query, "execute").mockImplementation(async () => {
                // The real callback reaches this first deletion only AFTER all
                // category/course/lesson snapshot rechecks and FOR UPDATE reads.
                // No deletion SQL has run yet, so a DELETE lock cannot mask a
                // regression in those recheck locks.
                reachedDeletion();
                await bounded(gate, "cleanup deletion gate");
                return execute();
              });
            }
            return query;
          });
          try {
            return await callback(tx);
          } finally {
            deleteSpy.mockRestore();
          }
        }, config),
      );
      cleanup = inspectProgressLeftovers(
        fixtureRun, [],
        async () => { throw new Error("Curriculum-only fixtures must not delete Clerk identities"); },
        message => output.push(message),
      );
      await bounded(Promise.race([
        ready,
        cleanup.then(() => { throw new Error("Cleanup finished before the deletion gate"); }),
      ]), "curriculum rechecks");
      expect(output).toEqual([]);

      write = (async () => {
        try {
          const result = change === "course-edit"
            ? await connection.query("UPDATE courses SET description = $1 WHERE id = $2 RETURNING id",
              ["Concurrent editorial course content", course.id])
            : change === "lesson-edit"
            ? await connection.query("UPDATE lessons SET content = $1 WHERE id = $2 RETURNING id",
              ["Concurrent editorial lesson content", lesson.id])
            : await connection.query(
              "INSERT INTO lessons (course_id, title, content) VALUES ($1, $2, $3) RETURNING id",
              [course.id, `Concurrent new lesson ${fixtureRun}`, "Real new content"],
            );
          if (change === "lesson-insert") lessonIds.push(...result.rows.map(row => Number(row.id)));
          await connection.query("COMMIT");
          return { rowCount: result.rowCount, committed: true };
        } catch (error) {
          await connection.query("ROLLBACK");
          return { rowCount: null, committed: false, errorCode: (error as { code?: string }).code };
        } finally {
          writeSettled = true;
        }
      })();
      // Poll real PostgreSQL lock ownership, rather than assuming a slow write
      // is blocked. An early success or unrelated failure must fail this test.
      await vi.waitFor(async () => {
        expect(writeSettled, "writer finished while cleanup was paused").toBe(false);
        expect(await observeBlocking!()).toBe(true);
      }, { timeout: 4000, interval: 20 });
      expect(writeSettled).toBe(false);
      expect(output).toEqual([]);
      releaseCleanup();
      await bounded(cleanup, "cleanup commit");
      const result = await bounded(write, "concurrent writer");
      // Once cleanup commits, an edit affects no row; a new FK child is
      // rejected because its parent has gone. Neither can resurrect curriculum.
      expect(result).toEqual(change === "lesson-insert"
        ? { rowCount: null, committed: false, errorCode: "23503" }
        : { rowCount: 0, committed: true });
      expect(output).toEqual([
        `Removed confirmed disposable records for ${fixtureRun}. Re-run dry run to check for remaining Clerk users.`,
      ]);
      expect(await db.select().from(lessonsTable).where(eq(lessonsTable.courseId, course.id))).toEqual([]);
      expect(await db.select().from(coursesTable).where(eq(coursesTable.id, course.id))).toEqual([]);
      expect(await db.select().from(categoriesTable).where(eq(categoriesTable.id, category.id))).toEqual([]);
    } finally {
      releaseCleanup();
      // Release the gate and settle both operations before restoring the spy
      // or tearing down fixtures, even when setup or a race assertion fails.
      await Promise.allSettled([cleanup, write].filter(promise => promise !== undefined));
      transactionSpy?.mockRestore();
      if (writer) {
        try {
          await writer.query("ROLLBACK");
        } finally {
          writer.release();
        }
      }
      if (lessonIds.length) await db.delete(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
      if (courseId !== undefined) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
      if (categoryId !== undefined) await db.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    }
  }, 30000,
);