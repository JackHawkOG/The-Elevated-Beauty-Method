import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { activityTable, db } from "@workspace/db";
import { expect, test } from "vitest";
import { activityRun, categoryRun, confirmedRun, eligibleRun, identityRun, staleCandidates, type Candidate } from "./member-progress-leftovers";
import { inspectProgressLeftovers } from "./member-progress-leftovers-cli";
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
    const noClerkDelete = async () => { throw new Error("Activity-only cleanup must not delete a Clerk identity"); };
    await inspectProgressLeftovers(undefined, [], noClerkDelete, message => output.push(message));
    const report = JSON.parse(output[0]) as { candidates: Array<{ kind: string; id: string; run: string }> };
    expect(report.candidates.filter(entry => createdIds.includes(Number(entry.id))))
      .toEqual([
        { kind: "activity", id: String(createdIds[0]), run: fixtureRun,
          createdAt: old.toISOString(), marker: actor, type: "enrollment", description },
        { kind: "activity", id: String(createdIds[6]), run: otherRun,
          createdAt: old.toISOString(), marker: `Progress Elevated ${otherRun}`, type: "enrollment", description },
      ]);
    expect(output.at(-1)).toMatch(/Dry run only; nothing deleted/);
    expect((await db.select({ id: activityTable.id }).from(activityTable)
      .where(inArray(activityTable.id, createdIds))).map(row => row.id)).toEqual(createdIds);

    await inspectProgressLeftovers(confirmedRun(["--delete", fixtureRun, fixtureRun]), [], noClerkDelete, () => {});
    expect((await db.select({ id: activityTable.id }).from(activityTable)
      .where(inArray(activityTable.id, createdIds))).map(row => row.id))
      .toEqual(createdIds.slice(1));
    // A second attempt cannot remove the recent exact match.
    await expect(inspectProgressLeftovers(fixtureRun, [], noClerkDelete, () => {})).rejects.toThrow(/fully stale/);
  } finally {
    if (createdIds.length) {
      await db.delete(activityTable).where(inArray(activityTable.id, createdIds));
    }
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