import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, activityTable, announcementsTable, usersTable } from "../../../lib/db/src/index";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";

async function signIn(page: Page, email: string) {
  await page.goto("/dashboard");
  await clerk.signIn({ page, emailAddress: email });
  await page.goto("/dashboard");
  await expect(page.locator('[data-sidebar="footer"]')).toContainText(email);
}

test("real owner and admin can review a disposable ambiguous post; a member cannot", async ({ page }) => {
  test.setTimeout(150_000);
  requireAuditDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = randomBytes(8).toString("hex");
  const title = `Announcement review fixture ${tag}`;
  const body = `Disposable historical post ${tag}`;
  const authorName = `Fixture author ${tag}`;
  const email = (role: string) => `announcement-review-${role}-${tag}+clerk_test@example.com`;
  const createdUsers: string[] = [];
  const postIds: number[] = [];
  let feedId: number | undefined;

  try {
    for (const role of ["owner", "admin", "member"] as const) {
      const user = await client.users.createUser({
        emailAddress: [email(role)], firstName: "Review", lastName: role,
        publicMetadata: { role },
        privateMetadata: { announcementReviewLiveFixture: "v1" },
        skipPasswordRequirement: true,
      });
      createdUsers.push(user.id);
    }

    // The duplicate title makes both posts ambiguous. The independent fixture
    // ledger (these IDs and the unique body) identifies only the first pairing.
    const posts = await db.insert(announcementsTable).values([
      { title, body, authorName },
      { title, body: `Other disposable historical post ${tag}`, authorName },
    ]).returning({ id: announcementsTable.id });
    postIds.push(...posts.map(post => post.id));
    const [feed] = await db.insert(activityTable).values({
      type: "announcement", description: "posted an announcement",
      actorName: authorName, entityTitle: title,
    }).returning({ id: activityTable.id });
    feedId = feed.id;

    await signIn(page, email("member"));
    await page.goto("/announcement-activity-review");
    await expect(page.getByRole("heading", { name: "Older announcement feed review" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "404 Page Not Found" })).toBeVisible();
    const memberResponses = await page.evaluate(async ({ postId, activityId }) => {
      const list = await fetch("/api/announcements/activity-review");
      const attach = await fetch(`/api/announcements/${postId}/activity-review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityId, revision: "0".repeat(64), evidence: "Fixture evidence belongs to this post", independentlyVerified: true }),
      });
      return [list.status, attach.status];
    }, { postId: postIds[0], activityId: feedId });
    expect(memberResponses).toEqual([403, 403]);

    for (const role of ["admin", "owner"] as const) {
      await clerk.signOut({ page });
      await signIn(page, email(role));
      await page.goto("/announcement-activity-review");
      await expect(page.getByRole("heading", { name: "Older announcement feed review" })).toBeVisible();
      const first = page.locator("article").filter({ has: page.getByRole("heading", { name: `Post #${postIds[0]}: ${title}` }) });
      await expect(first).toContainText(body);
      await expect(first).toContainText(`Feed #${feedId}: ${title}`);
      await expect(first).toContainText("repeated announcement title");
      const second = page.locator("article").filter({ has: page.getByRole("heading", { name: `Post #${postIds[1]}: ${title}` }) });
      await expect(second).toBeVisible();
    }

    const first = page.locator("article").filter({ has: page.getByRole("heading", { name: `Post #${postIds[0]}: ${title}` }) });
    await first.getByRole("button", { name: "Review this pairing" }).click();
    const evidence = `Disposable fixture ledger ${tag}: post #${postIds[0]} with body "${body}" pairs with feed #${feedId}; post #${postIds[1]} does not.`;
    await first.getByLabel(/Independent evidence for this exact post/).fill(evidence);
    await first.getByLabel(/I verified evidence beyond/).check();
    await first.getByRole("button", { name: "Attach source ID" }).click();
    await expect(page.getByRole("status")).toContainText("Source ID attached");
    await expect(first).toHaveCount(0);
    await expect(page.locator("article").filter({ has: page.getByRole("heading", { name: `Post #${postIds[1]}: ${title}` }) }))
      .toContainText(`Already linked to post #${postIds[0]}`);
    const [linked] = await db.select().from(activityTable).where(eq(activityTable.id, feedId));
    expect(linked).toMatchObject({
      sourceAnnouncementId: postIds[0], sourceEvidence: evidence, sourceReviewedBy: createdUsers[0],
    });
    expect(linked.sourceReviewedAt).toBeInstanceOf(Date);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Older announcement feed review" })).toBeVisible();
    await expect(page.locator("article").filter({ has: page.getByRole("heading", { name: `Post #${postIds[0]}: ${title}` }) })).toHaveCount(0);
  } finally {
    await page.close();
    // Never delete by title alone: inspect ownership and remove only the IDs
    // inserted by this run. Leave any unexpected row untouched.
    try {
      if (feedId !== undefined) {
        const [feed] = await db.select().from(activityTable).where(eq(activityTable.id, feedId));
        if (feed && (feed.type !== "announcement" || feed.entityTitle !== title || feed.actorName !== authorName ||
          (feed.sourceAnnouncementId !== null && feed.sourceAnnouncementId !== postIds[0]))) {
          throw new Error("Review fixture feed changed unexpectedly; refusing cleanup");
        }
        await db.delete(activityTable).where(and(eq(activityTable.id, feedId), eq(activityTable.entityTitle, title)));
      }
      if (postIds.length) {
        const posts = await db.select().from(announcementsTable).where(inArray(announcementsTable.id, postIds));
        if (posts.some(post => post.title !== title || post.authorName !== authorName || post.actorId !== null)) {
          throw new Error("Review fixture posts changed unexpectedly; refusing cleanup");
        }
        await db.delete(announcementsTable).where(and(inArray(announcementsTable.id, postIds), eq(announcementsTable.title, title)));
      }
    } finally {
      if (createdUsers.length) await db.delete(usersTable).where(inArray(usersTable.clerkId, createdUsers));
      await Promise.all(createdUsers.map(id => client.users.deleteUser(id)));
    }
  }
});