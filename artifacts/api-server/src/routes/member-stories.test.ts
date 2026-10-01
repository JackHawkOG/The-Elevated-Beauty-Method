import { afterAll, beforeAll, expect, test, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, memberStoriesTable, pool } from "@workspace/db";
import { requireDevelopmentDatabase } from "./test-development-database";
import { ensureMemberStoriesSchema } from "../lib/ensure-member-stories-schema";

vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header("x-test-user") ?? null }),
  clerkClient: { users: { getUser: async (id: string) => {
    if (id.startsWith("missing-")) throw Object.assign(new Error("Unknown account"), { status: 404 });
    return {
      publicMetadata: { role: id.startsWith("test-owner-") ? "owner" : "member" },
      privateMetadata: { ...(id.includes("-fixture-") ? { memberStoriesLiveFixture: "member-stories-live-v1" } : {}) },
      primaryEmailAddress: { emailAddress: `${id}@example.test` },
    };
  } } },
}));

const run = randomUUID();
const owner = `test-owner-${run}`;
const member = `test-member-${run}`;
const created: number[] = [];
let server: Server;
let base: string;

async function request(path: string, user?: string, method = "GET", body?: object, headers?: Record<string, string>) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(user ? { "x-test-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 1200)}`);
  return { status: response.status, data: JSON.parse(text) as any, cache: response.headers.get("cache-control") };
}

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureMemberStoriesSchema();
  const { default: routes } = await import("./member-stories");
  const app = express();
  app.use(express.json(), routes);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (created.length) await db.delete(memberStoriesTable).where(inArray(memberStoriesTable.id, created));
  } finally {
    await pool.end();
  }
});

test("only explicitly permitted stories reach the public feed and withdrawal isolates a story", async () => {
  const input = { quote: `Verified ${run}`, attribution: "Approved name", permissionRecord: "Written permission", permissionConfirmed: true };

  const key = "a".repeat(32);
  expect((await request("/member-stories", undefined, "POST", input)).status).toBe(401);
  expect((await request("/member-stories", member, "POST", input)).status).toBe(403);
  expect((await request("/member-stories", owner, "POST", { ...input, permissionConfirmed: false })).status).toBe(400);
  expect((await request("/member-stories", owner, "POST", { ...input, permissionRecord: "  " })).status).toBe(400);
  const first = await request("/member-stories", owner, "POST", input);
  expect(first.status).toBe(201);
  created.push(first.data.id);
  expect(first.data.permissionRecordedBy).toBe(owner);
  expect(first.data.permissionRecord).toBe(input.permissionRecord);
  const second = await request("/member-stories", owner, "POST", { ...input, quote: `Another ${run}` });
  expect(second.status).toBe(201);
  created.push(second.data.id);
  expect((await request("/member-stories/manage", member)).status).toBe(403);
  expect((await request("/member-stories/manage", owner)).data.find((story: { id: number }) => story.id === first.data.id).permissionRecord).toBe(input.permissionRecord);
  const publicBefore = await request("/member-stories");
  expect(publicBefore.cache).toContain("no-store");
  expect(publicBefore.data.filter((story: { id: number }) => created.includes(story.id))).toHaveLength(2);
  expect(publicBefore.data.find((story: { id: number }) => story.id === first.data.id)).not.toHaveProperty("permissionRecord");
  expect((await request(`/member-stories/${first.data.id}/withdraw`, member, "POST")).status).toBe(403);
  const withdrawn = await request(`/member-stories/${first.data.id}/withdraw`, owner, "POST");
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.data.withdrawnAt).toBeTruthy();
  expect((await request(`/member-stories/${first.data.id}/withdraw`, owner, "POST")).status).toBe(404);
  const publicAfter = await request("/member-stories");
  expect(publicAfter.data.some((story: { id: number }) => story.id === first.data.id)).toBe(false);
  expect(publicAfter.data.some((story: { id: number }) => story.id === second.data.id)).toBe(true);
});

test("live test publication is visible only to the matching visitor and stays isolated until withdrawal", async () => {
  const input = { quote: `Isolated story ${run}`, attribution: "Browser fixture",
    permissionRecord: "Disposable permission", permissionConfirmed: true };
  const key = "a".repeat(32);
  const otherKey = "b".repeat(32);
  const header = { "x-story-test-visibility": key };
  expect((await request("/member-stories", owner, "POST", input, header)).status).toBe(403);
  expect((await request("/member-stories", `test-owner-fixture-${run}`, "POST", input, { "x-story-test-visibility": "bad" })).status).toBe(400);
  const published = await request("/member-stories", `test-owner-fixture-${run}`, "POST", input, header);
  expect(published.status).toBe(201);
  created.push(published.data.id);
  expect(published.data).not.toHaveProperty("testVisibilityKey");
  const inFeed = async (headers?: Record<string, string>) =>
    (await request("/member-stories", undefined, "GET", undefined, headers)).data.some(
      (row: { id: number }) => row.id === published.data.id,
    );
  expect(await inFeed()).toBe(false);
  expect(await inFeed({ "x-story-test-visibility": otherKey })).toBe(false);
  expect(await inFeed({ "x-story-test-visibility": "invalid" })).toBe(false);
  expect(await inFeed(header)).toBe(true);
  expect((await request("/member-stories/manage", `test-owner-fixture-${run}`)).data.find(
    (row: { id: number }) => row.id === published.data.id,
  )).not.toHaveProperty("testVisibilityKey");
  expect((await request("/member-stories/manage", owner)).data.some(
    (row: { id: number }) => row.id === published.data.id,
  )).toBe(false);
  expect((await request(`/member-stories/${published.data.id}/withdraw`, `test-owner-fixture-${run}`, "POST")).status).toBe(200);
  expect(await inFeed(header)).toBe(false);
});

test("signed-in removal requests hide the identified story and keep the claim private for owner review", async () => {
  const input = { quote: `Removal claim ${run}`, attribution: "Member name", permissionRecord: "Recorded permission", permissionConfirmed: true };
  const published = await request("/member-stories", owner, "POST", input);
  expect(published.status).toBe(201);
  created.push(published.data.id);
  const path = `/member-stories/${published.data.id}/removal-request`;
  expect((await request(path, undefined, "POST", { note: "This is me" })).status).toBe(401);
  expect((await request(path, member, "POST", { note: "   " })).status).toBe(400);
  expect((await request("/member-stories/not-a-number/removal-request", member, "POST", { note: "Mine" })).status).toBe(400);
  expect((await request(path, member, "POST", { note: "x".repeat(501) })).status).toBe(400);
  const removal = await request(path, member, "POST", { note: "I withdrew my permission" });
  expect(removal.status).toBe(200);
  expect(removal.data).toEqual({ storyId: published.data.id, hidden: true });
  expect(removal.data).not.toHaveProperty("permissionRecord");
  expect((await request(path, member, "POST", { note: "Again" })).status).toBe(429);
  const other = await request("/member-stories", owner, "POST", { ...input, quote: `Other story ${run}` });
  created.push(other.data.id);
  const publicList = await request("/member-stories");
  expect(publicList.data.some((story: { id: number }) => story.id === published.data.id)).toBe(false);
  expect(publicList.data.some((story: { id: number }) => story.id === other.data.id)).toBe(true);
  expect(JSON.stringify(publicList.data)).not.toContain("I withdrew my permission");
  expect((await request("/member-stories/manage", member)).status).toBe(403);
  expect((await request("/member-stories/removal-alerts")).status).toBe(401);
  expect((await request("/member-stories/removal-alerts", member)).status).toBe(403);
  const alerts = await request("/member-stories/removal-alerts", owner);
  expect(alerts.cache).toContain("no-store");
  expect(alerts.data.find((item: { storyId: number }) => item.storyId === published.data.id))
    .toEqual({ storyId: published.data.id, requestedAt: expect.any(String) });
  expect(JSON.stringify(alerts.data)).not.toContain(member);
  expect(JSON.stringify(alerts.data)).not.toContain(input.permissionRecord);
  expect(JSON.stringify(alerts.data)).not.toContain("I withdrew my permission");
  const managed = await request("/member-stories/manage", owner);

  const story = managed.data.find((row: { id: number }) => row.id === published.data.id);
  expect(story.removalRequestNote).toBe("I withdrew my permission");
  expect(story.removalRequestedBy).toBe(member);
  expect(story.removalRequesterEmail).toBe(`${member}@example.test`);
  expect(story.verifiedSubjectUserId).toBeNull();
  expect(story.removalRequesterIsVerifiedSubject).toBe(false);
  expect(story.withdrawnAt).toBeTruthy();
});

test("owner can privately review a hidden claim without republishing the story", async () => {
  const stillPending = await request("/member-stories", owner, "POST", {
    quote: `Still awaiting review ${run}`, attribution: "Approved name", permissionRecord: "Written permission",
    permissionConfirmed: true,
  });
  expect(stillPending.status).toBe(201);
  created.push(stillPending.data.id);
  expect((await request(`/member-stories/${stillPending.data.id}/removal-request`, `test-other-${run}`, "POST", { note: "Please remove" })).status).toBe(200);
  for (const outcome of ["withdrawal_confirmed", "claim_unsubstantiated", "inconclusive"] as const) {
    const published = await request("/member-stories", owner, "POST", {
      quote: `${outcome} ${run}`, attribution: "Approved name", permissionRecord: "Written permission",
      permissionConfirmed: true,
    });
    expect(published.status).toBe(201);
    created.push(published.data.id);
    const claimant = `test-claimant-${outcome}-${run}`;
    const reviewPath = `/member-stories/${published.data.id}/removal-review`;
    expect((await request(reviewPath, owner, "POST", { outcome, note: "Before claim" })).status).toBe(404);
    expect((await request(`/member-stories/${published.data.id}/removal-request`, claimant, "POST", { note: "Please remove this" })).status).toBe(200);
    expect((await request("/member-stories/removal-alerts", owner)).data.some((row: { storyId: number }) => row.storyId === published.data.id)).toBe(true);
    expect((await request(reviewPath, undefined, "POST", { outcome, note: "Privately assessed" })).status).toBe(401);
    expect((await request(reviewPath, member, "POST", { outcome, note: "Privately assessed" })).status).toBe(403);
    expect((await request(reviewPath, owner, "POST", { outcome, note: "  " })).status).toBe(400);
    const reviewed = await request(reviewPath, owner, "POST", { outcome, note: "Privately assessed" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.cache).toContain("no-store");
    expect(reviewed.data.removalReviewOutcome).toBe(outcome);
    expect(reviewed.data.removalReviewNote).toBe("Privately assessed");
    expect(reviewed.data.removalReviewedBy).toBe(owner);
    expect(reviewed.data.removalReviewedAt).toBeTruthy();
    expect((await request(reviewPath, owner, "POST", { outcome, note: "Again" })).status).toBe(404);
    expect((await request("/member-stories")).data.some((row: { id: number }) => row.id === published.data.id)).toBe(false);
    expect(JSON.stringify((await request("/member-stories")).data)).not.toContain("Privately assessed");
    expect((await request("/member-stories/manage", member)).status).toBe(403);
    expect((await request("/member-stories/manage", owner)).data.find((row: { id: number }) => row.id === published.data.id).removalReviewOutcome).toBe(outcome);
    const alertsAfterReview = await request("/member-stories/removal-alerts", owner);
    expect(alertsAfterReview.cache).toContain("no-store");
    expect(alertsAfterReview.data.some((row: { storyId: number }) => row.storyId === published.data.id)).toBe(false);
    expect(alertsAfterReview.data.some((row: { storyId: number }) => row.storyId === stillPending.data.id)).toBe(true);
  }
});

test("corrections append private decisions without erasing the first review or revealing the story", async () => {
  const published = await request("/member-stories", owner, "POST", {
    quote: `Corrected claim ${run}`, attribution: "Member name",
    permissionRecord: "Written permission", permissionConfirmed: true,
  });

  created.push(published.data.id);
  const reviewPath = `/member-stories/${published.data.id}/removal-review`;
  const correctionPath = `${reviewPath}/corrections`;
  const body = { outcome: "withdrawal_confirmed", note: "Confirmed after further checking", expectedReviewId: 0 };
  expect((await request(correctionPath, owner, "POST", body)).status).toBe(404);
  expect((await request(`/member-stories/${published.data.id}/removal-request`, `test-correction-claimant-${run}`, "POST", { note: "This concerns me" })).status).toBe(200);
  expect((await request(correctionPath, owner, "POST", body)).status).toBe(404);
  expect((await request(reviewPath, owner, "POST", { outcome: "inconclusive", note: "First assessment" })).status).toBe(200);
  expect((await request(correctionPath, undefined, "POST", body)).status).toBe(401);
  expect((await request(correctionPath, member, "POST", body)).status).toBe(403);
  expect((await request(correctionPath, owner, "POST", { ...body, note: "  " })).status).toBe(400);
  expect((await request(correctionPath, owner, "POST", { ...body, expectedReviewId: -1 })).status).toBe(400);
  const [first, stale] = await Promise.all([
    request(correctionPath, owner, "POST", body),
    request(correctionPath, owner, "POST", body),
  ]);
  expect([first.status, stale.status].sort()).toEqual([200, 409]);
  const successful = first.status === 200 ? first : stale;
  expect(successful.cache).toContain("private");
  expect(successful.data.reviewHistory.map((entry: { note: string }) => entry.note))
    .toEqual(["First assessment", body.note]);
  expect(successful.data.reviewHistory[0]).toMatchObject({ id: 0, outcome: "inconclusive", reviewedBy: owner, reviewedAt: expect.any(String) });
  expect(successful.data.reviewHistory[1]).toMatchObject({ outcome: body.outcome, reviewedBy: owner, reviewedAt: expect.any(String) });
  expect(successful.data.removalReviewOutcome).toBe("inconclusive");
  expect((await request(correctionPath, owner, "POST", body)).status).toBe(409);
  const next = await request(correctionPath, owner, "POST", {
    outcome: "claim_unsubstantiated", note: "New evidence", expectedReviewId: successful.data.reviewHistory[1].id,
  });
  expect(next.status).toBe(200);
  expect(next.data.reviewHistory.map((entry: { note: string }) => entry.note))
    .toEqual(["First assessment", body.note, "New evidence"]);
  const managed = await request("/member-stories/manage", owner);

  expect(managed.data.find((story: { id: number }) => story.id === published.data.id).reviewHistory).toEqual(next.data.reviewHistory);
  expect((await request("/member-stories/manage", member)).status).toBe(403);
  const publicList = await request("/member-stories");
  expect(publicList.data.some((story: { id: number }) => story.id === published.data.id)).toBe(false);
  expect(JSON.stringify(publicList.data)).not.toContain("New evidence");
  expect(JSON.stringify((await request("/member-stories/removal-alerts", owner)).data)).not.toContain("New evidence");
});

test("owner verifies a subject at publication, and claims snapshot the account match without disclosing proof", async () => {
  const subject = `test-subject-${run}`;
  const input = { quote: `Verified ${run}`, attribution: "Approved name", permissionRecord: "Written permission", permissionConfirmed: true };

  const linked = { ...input, verifiedSubjectUserId: subject, subjectVerificationRecord: "Identity confirmed privately" };
  expect((await request("/member-stories", member, "POST", linked)).status).toBe(403);
  expect((await request("/member-stories", owner, "POST", { ...input, verifiedSubjectUserId: subject })).status).toBe(400);
  expect((await request("/member-stories", owner, "POST", { ...linked, subjectVerificationRecord: " " })).status).toBe(400);
  expect((await request("/member-stories", owner, "POST", { ...linked, verifiedSubjectUserId: `missing-${run}` })).status).toBe(400);
  const matched = await request("/member-stories", owner, "POST", linked);
  expect(matched.status).toBe(201);
  created.push(matched.data.id);
  expect(matched.data.verifiedSubjectUserId).toBe(subject);
  expect(matched.data.subjectVerificationRecord).toBe(linked.subjectVerificationRecord);
  expect(matched.data.subjectVerifiedAt).toBeTruthy();
  expect(matched.data.subjectVerifiedBy).toBe(owner);
  const other = await request("/member-stories", owner, "POST", { ...linked, quote: `Other linked ${run}` });
  created.push(other.data.id);
  const publicList = await request("/member-stories");
  expect(JSON.stringify(publicList.data)).not.toContain(subject);
  expect(JSON.stringify(publicList.data)).not.toContain(linked.subjectVerificationRecord);
  expect((await request(`/member-stories/${matched.data.id}/removal-request`, subject, "POST", { note: "Withdraw consent" })).status).toBe(200);
  expect((await request(`/member-stories/${other.data.id}/removal-request`, `test-unlinked-claimant-${run}`, "POST", { note: "My story" })).status).toBe(200);
  const managed = await request("/member-stories/manage", owner);
  expect(managed.data.find((story: { id: number }) => story.id === matched.data.id).removalRequesterIsVerifiedSubject).toBe(true);
  expect(managed.data.find((story: { id: number }) => story.id === other.data.id).removalRequesterIsVerifiedSubject).toBe(false);
  expect((await request("/member-stories/manage", member)).status).toBe(403);
  const hidden = await request("/member-stories");
  expect(hidden.data.some((story: { id: number }) => story.id === matched.data.id || story.id === other.data.id)).toBe(false);
  expect(JSON.stringify((await request("/member-stories/removal-alerts", owner)).data)).not.toContain(subject);
});
