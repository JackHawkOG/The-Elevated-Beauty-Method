import { expect, test } from "vitest";
import { planAnnouncementActivityRepair } from "./reconcile-announcement-activity";

const at = new Date("2026-08-07T15:42:46.363Z");
const later = new Date("2026-08-07T15:42:49.563Z");

function post(id: number, title: string, authorName = "Nikki", legacy = true) {
  return {
    id, title, authorName, actorId: legacy ? null : "user-1",
    requestKey: legacy ? null : "request-1", createdAt: at,
  };
}

function feed(id: number, entityTitle: string, actorName = "Nikki", createdAt = later, sourceAnnouncementId: number | null = null) {
  return { id, entityTitle, actorName, createdAt, sourceAnnouncementId };
}

test("repairs only uniquely absent legacy titles and recognizes a repeat run", () => {
  const announcements = [post(1, "Welcome ™"), post(2, "First step"), post(3, "New post", "Nikki", false)];
  const activities = [feed(4, "Welcome™")];
  const first = planAnnouncementActivityRepair(announcements, activities);
  expect(first.missing.map(row => row.id)).toEqual([2]);
  expect(first.review).toEqual([]);
  expect(planAnnouncementActivityRepair(announcements, [...activities, feed(5, "First step", "Nikki", at)]))
    .toEqual({ missing: [], review: [] });
});

test("does not guess which of repeated titles, authors or feed entries belong together", () => {
  const announcements = [post(1, "Same", "Nikki"), post(2, "Same", "Other"),
    post(3, "Wrong author"), post(4, "Too late"), post(5, "Multiple"), post(6, "Unique")];
  const activities = [
    feed(10, "Same", "Nikki"),
    feed(11, "Wrong author", "Other"),
    feed(12, "Too late", "Nikki", new Date(at.getTime() + 600_000)),
    feed(13, "Multiple"),
    feed(14, "Multiple"),
    feed(15, "Unique", "Nikki", new Date(at.getTime() - 1000)),
  ];
  const result = planAnnouncementActivityRepair(announcements, activities);
  expect(result.missing).toEqual([]);
  expect(result.review.map(row => [row.announcementId, row.reason])).toEqual([
    [1, "repeated announcement title"],
    [2, "repeated announcement title"],
    [3, "feed entry has a different author or timestamp"],
    [4, "feed entry has a different author or timestamp"],
    [5, "multiple feed entries with this title"],
    [6, "feed entry has a different author or timestamp"],
  ]);
  expect(result.review[0].activityIds).toEqual([10]);
});

test("two announcements without feed entries but with the same title require review", () => {
  const result = planAnnouncementActivityRepair([post(1, "Repeat"), post(2, "Repeat")], []);
  expect(result.missing).toEqual([]);
  expect(result.review.map(row => row.announcementId)).toEqual([1, 2]);
});

test("a linked feed entry is recognized by ID even after its author label changes", () => {
  const result = planAnnouncementActivityRepair(
    [post(1, "Repeat"), post(2, "Repeat"), post(3, "Unique")],
    [feed(10, "Repeat", "Old author", later, 1), feed(11, "Unique", "Old author", later, 3)],
  );
  expect(result.missing).toEqual([]);
  expect(result.review).toEqual([{ announcementId: 2, activityIds: [10], reason: "repeated announcement title" }]);
});

test("an old matching feed item is not retroactively linked during repair", () => {
  const historical = feed(7, "Original");
  const result = planAnnouncementActivityRepair([post(1, "Original")], [historical]);
  expect(result).toEqual({ missing: [], review: [] });
  expect(historical.sourceAnnouncementId).toBeNull();
});

test("preserves the two historical short feed display names without scheduling duplicate posts", () => {
  const announcements = [
    post(1, "Welcome to The Elevated Beauty Method™", "Nikki — Blushing Beauty By Nikki"),
    post(3, "The Elevated Beauty Method™ is officially open", "Nikki — Blushing Beauty By Nikki"),
  ];
  const activities = [
    feed(3, announcements[0].title, "Nikki"),
    feed(7, announcements[1].title, "Nikki"),
  ];
  const plan = planAnnouncementActivityRepair(announcements, activities);
  expect(plan.missing).toEqual([]);
  expect(plan.review).toEqual([
    { announcementId: 1, activityIds: [3], reason: "feed entry has a different author or timestamp" },
    { announcementId: 3, activityIds: [7], reason: "feed entry has a different author or timestamp" },
  ]);
  expect(activities.map(row => [row.actorName, row.sourceAnnouncementId]))
    .toEqual([["Nikki", null], ["Nikki", null]]);
});