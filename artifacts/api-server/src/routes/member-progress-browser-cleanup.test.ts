import { expect, test, vi } from "vitest";
import { runWithCleanup } from "./member-progress-browser-cleanup";

test("reports the original failure and all cleanup failures, while attempting later steps", async () => {
  const original = new Error("dashboard progress mismatch");
  const firstFailure = new Error("member delete denied");
  const secondFailure = new Error("pool close failed");
  const laterStep = vi.fn(async () => {});
  let thrown: unknown;

  try {
    await runWithCleanup(
      async () => { throw original; },
      () => [
        { name: "Delete member", run: async () => { throw firstFailure; } },
        { name: "Delete Clerk user", run: laterStep },
        { name: "Close pool", run: async () => { throw secondFailure; } },
      ],
    );
  } catch (error) {
    thrown = error;
  }

  expect(laterStep).toHaveBeenCalledOnce();
  expect(thrown).toBeInstanceOf(AggregateError);
  const aggregate = thrown as AggregateError;
  expect(aggregate.errors[0]).toBe(original);
  expect(aggregate.errors.slice(1).map((error: Error) => error.cause)).toEqual([firstFailure, secondFailure]);
  expect(aggregate.message).toContain("dashboard progress mismatch");
  expect(aggregate.message).toContain("Delete member: member delete denied");
  expect(aggregate.message).toContain("Close pool: pool close failed");
});

test("keeps a lone browser failure unchanged and reports cleanup-only failures", async () => {
  const original = new Error("browser failed");
  await expect(runWithCleanup(async () => { throw original; }, () => [])).rejects.toBe(original);
  await expect(runWithCleanup(async () => "ok", () => [
    { name: "Delete fixture", run: async () => { throw new Error("DB unavailable"); } },
  ])).rejects.toThrow("Browser check cleanup failed: Delete fixture: DB unavailable");
});