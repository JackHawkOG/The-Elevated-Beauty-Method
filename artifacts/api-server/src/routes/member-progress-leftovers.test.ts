import { expect, test } from "vitest";
import { activityRun, categoryRun, confirmedRun, eligibleRun, identityRun, staleCandidates, type Candidate } from "./member-progress-leftovers";

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
  expect(() => eligibleRun([], now, run)).toThrow(/fully stale/);
  expect(eligibleRun([candidate("clerk"), candidate("member")], now, run)).toHaveLength(2);
  expect(eligibleRun([candidate("activity")], now, run)).toEqual([candidate("activity")]);
  expect(() => eligibleRun([candidate("activity"), candidate("activity", new Date("2026-09-27T11:30:00Z"))], now, run))
    .toThrow(/fully stale/);
});

test("deletion requires the same exact run ID twice", () => {
  expect(confirmedRun([])).toBeUndefined();
  expect(confirmedRun(["--delete", run, run])).toBe(run);
  expect(() => confirmedRun(["--delete", run])).toThrow();
  expect(() => confirmedRun(["--delete", run, "87654321-1234-1234-1234-123456789abc"])).toThrow();
});