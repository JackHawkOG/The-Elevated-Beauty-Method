import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityEntityTitle } from "./activity-entity-title";
import type { ActivityItem } from "@workspace/api-client-react";

const item: ActivityItem = {
  id: 1,
  type: "announcement",
  description: "posted an announcement",
  entityTitle: "A community update",
  sourceAnnouncementId: 42,
  createdAt: new Date().toISOString(),
};

test("linked announcement titles open the original community post", () => {
  const html = renderToStaticMarkup(<ActivityEntityTitle item={item} className="font-bold" />);
  expect(html).toContain('href="/community#announcement-42"');
  expect(html).toContain("A community update");
});

test("historical unlinked entries and non-announcement activity stay plain text", () => {
  for (const entry of [{ ...item, sourceAnnouncementId: null }, { ...item, type: "enrollment" }]) {
    const html = renderToStaticMarkup(<ActivityEntityTitle item={entry} className="font-bold" />);
    expect(html).toContain("<span");
    expect(html).not.toContain("href=");
  }
});