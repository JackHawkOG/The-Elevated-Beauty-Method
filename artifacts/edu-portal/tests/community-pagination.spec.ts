import { expect, test } from "@playwright/test";
import type { Announcement } from "@workspace/api-client-react";

// This suite isolates auth/API transport; announcements.test.ts exercises the
// real database cursor with concurrent POSTs. No fixture reaches the public feed.
function comparePosts(a: Announcement, b: Announcement) {
  return Number(b.pinned) - Number(a.pinned) ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id;
}

for (const pinned of [true, false]) {
  test(`older cards stay reachable when another session posts ${pinned ? "a pinned" : "an unpinned"} announcement`, async ({ context, page }) => {
    const older: Announcement[] = Array.from({ length: 47 }, (_, i) => ({
      id: i + 1,
      title: `Older announcement ${i + 1}`,
      body: `Older message ${i + 1}`,
      authorName: "Earlier author",
      pinned: i < 24,
      // Different dates plus exact ties in both groups require all three sort keys.
      createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 3))).toISOString(),
    })).sort(comparePosts);
    const linked = older[30];
    const newPost: Announcement = {
      id: 100, title: "New post from another session", body: "Arrived between pages",
      authorName: "Other member", pinned, createdAt: "2026-02-01T00:00:00.000Z",
    };
    let posts = [...older];
    const cursors: Array<number | undefined> = [];
    let detailRequests = 0;
    let writes = 0;
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));

    // Both tabs share the API fixture, but have different signed-in identities
    // and independent query caches. Mutating this store models another session.
    await context.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/dashboard/recent-activity") {
        await route.fulfill({ json: [] });
      } else if (url.pathname === `/api/announcements/${linked.id}`) {
        detailRequests++;
        await route.fulfill({ json: linked });
      } else if (url.pathname === "/api/announcements" && request.method() === "POST") {
        expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i);
        expect(request.postDataJSON()).toEqual({ title: newPost.title, body: newPost.body, pinned });
        writes++;
        posts = [...posts, newPost].sort(comparePosts);
        await route.fulfill({ status: 201, json: newPost });
      } else if (url.pathname === "/api/announcements") {
        const after = url.searchParams.get("after");
        const cursor = after === null ? undefined : Number(after);
        // Only the reader requests pages with a cursor.
        if (request.frame().page() === page) cursors.push(cursor);
        expect(url.searchParams.get("limit")).toBe("20");
        const start = cursor === undefined ? 0 : posts.findIndex(post => post.id === cursor) + 1;
        if (cursor !== undefined) expect(start).toBeGreaterThan(0);
        await route.fulfill({ json: posts.slice(start, start + 20) });
      } else {
        throw new Error(`Unexpected community request: ${request.method()} ${url.pathname}`);
      }
    });
    await page.addInitScript(() => sessionStorage.setItem("audit-test-tab-account", "reader"));
    await page.goto(`/tests/community-harness.html#announcement-${linked.id}`);
    const cards = page.locator('[id^="announcement-"]');
    const cardIds = () => cards.evaluateAll(nodes => nodes.map(node => Number(node.id.replace("announcement-", ""))));
    await expect.poll(cardIds).toEqual([linked.id, ...older.slice(0, 20).map(post => post.id)]);
    expect(detailRequests).toBe(1);
    expect(cursors).toEqual([undefined]);
    await expect(page.locator(`#announcement-${linked.id}`)).toContainText(linked.body);

    const writer = await context.newPage();
    try {
      await writer.addInitScript(() => sessionStorage.setItem("audit-test-tab-account", "writer"));
      await writer.goto("/tests/community-harness.html");
      // The post dialog has no pin control. Use the supported API contract from
      // this independent session so both cases send their actual pinned value.
      const result = await writer.evaluate(async post => {
        const response = await fetch("/api/announcements", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ title: post.title, body: post.body, pinned: post.pinned }),
        });
        return { status: response.status, post: await response.json() };
      }, newPost);
      expect(result).toEqual({ status: 201, post: newPost });
      expect(writes).toBe(1);
    } finally {
      await writer.close();
    }

    // The reader still holds its original first page; the linked detail card is
    // not the pagination cursor. A newer pinned post is before that cursor;
    // a newer unpinned post is after it and before the older unpinned group.
    await expect.poll(cardIds).toEqual([linked.id, ...older.slice(0, 20).map(post => post.id)]);
    const firstCursor = older[19].id;
    const secondPage = posts.slice(posts.findIndex(post => post.id === firstCursor) + 1).slice(0, 20);
    const loaded = [...older.slice(0, 20), ...secondPage];
    const loadMore = page.getByRole("button", { name: "Load older announcements", exact: true });
    await loadMore.click();
    await expect.poll(cardIds).toEqual(loaded.map(post => post.id));
    // The previously separate linked card now occupies its proper feed position
    // exactly once, and its body remains available.
    await expect(page.locator(`#announcement-${linked.id}`)).toHaveCount(1);
    await expect(page.locator(`#announcement-${linked.id}`)).toContainText(linked.body);
    expect(detailRequests).toBe(1);
    expect(cursors).toEqual([undefined, firstCursor]);

    await loadMore.click();
    const expected = posts.filter(post => !pinned || post.id !== newPost.id).map(post => post.id);
    await expect.poll(cardIds).toEqual(expected);
    await expect(loadMore).toHaveCount(0);
    const actual = await cardIds();
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual.filter(id => id !== newPost.id)).toEqual(older.map(post => post.id));
    expect(cursors).toEqual([undefined, firstCursor, secondPage[19].id]);
    expect(browserErrors).toEqual([]);
  });
}