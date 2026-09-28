import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import {
  communityFixtureEmail, communityFixturePrivateMetadata, isCommunityFixtureActivity,
  isCommunityFixturePost, isCommunityFixtureUnlinkedActivity,
  newCommunityFixtureTag, requireCommunityDevelopment,
} from "./community-fixtures";

test("a signed-in reader follows a feed announcement and sees unlinked history as text", async ({ page }) => {
  test.setTimeout(120_000);
  requireCommunityDevelopment();
  await clerkSetup();
  const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const tag = newCommunityFixtureTag();
  const email = communityFixtureEmail(tag);
  const title = `Community retry ${tag}`;
  const body = `Message ${tag}`;
  const legacyTitle = `Community legacy ${tag}`;
  let userId: string | undefined;
  let legacyId: number | undefined;
  try {
    userId = (await client.users.createUser({
      emailAddress: [email], firstName: "Community", lastName: "Check",
      skipPasswordRequirement: true, privateMetadata: communityFixturePrivateMetadata,
    })).id;
    await page.goto("/community");
    await clerk.signIn({ page, emailAddress: email });
    await page.goto("/community");
    await expect(page.getByRole("heading", { name: "Community", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New Post" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("What's new?").fill(title);
    await dialog.getByPlaceholder("Share the details with the community...").fill(body);
    await dialog.getByRole("button", { name: "Post Announcement" }).click();
    await expect(dialog).toHaveCount(0);

    const { db, activityTable, announcementsTable } = await import("../../../lib/db/src/index");
    const posts = await db.select().from(announcementsTable)
      .where(and(eq(announcementsTable.actorId, userId), eq(announcementsTable.title, title)));
    expect(posts).toHaveLength(1);
    const postId = posts[0].id;
    const [legacy] = await db.insert(activityTable).values({
      type: "announcement", description: "posted an announcement",
      actorName: "Community Check", entityTitle: legacyTitle,
      sourceAnnouncementId: null,
    }).returning({ id: activityTable.id });
    legacyId = legacy.id;

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
    const pulse = page.getByText("Community Pulse", { exact: true }).locator("..").locator("..");
    const linked = pulse.getByRole("link", { name: title, exact: true });
    await expect(linked).toHaveAttribute("href", `/community#announcement-${postId}`);
    const historical = pulse.getByText(legacyTitle, { exact: true });
    await expect(historical).toBeVisible();
    await expect(pulse.getByRole("link", { name: legacyTitle, exact: true })).toHaveCount(0);
    await expect(historical).not.toHaveAttribute("href", /./);

    await linked.click();
    await expect(page).toHaveURL(new RegExp(`/community#announcement-${postId}$`));
    const target = page.locator(`#announcement-${postId}`);
    await expect(target).toBeVisible();
    await expect(target.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(target).toContainText(body);
  } finally {
    // Close the page before removing records so late requests cannot recreate fixture data.
    await page.close();
    if (userId) {
      const { db, activityTable, announcementsTable, usersTable } = await import("../../../lib/db/src/index");
      try {
        const posts = await db.select().from(announcementsTable)
          .where(eq(announcementsTable.actorId, userId));
        if (posts.some(post => !isCommunityFixturePost(post, tag))) {
          throw new Error("Non-fixture announcement; refusing deletion");
        }
        const unlinked = legacyId === undefined ? [] : await db.select().from(activityTable)
          .where(eq(activityTable.id, legacyId));
        if (unlinked.some(row => !isCommunityFixtureUnlinkedActivity(row, tag))) {
          throw new Error("Historical fixture changed; refusing deletion");
        }
        const activityIds = unlinked.map(row => row.id);
        if (posts.length) {
          const linked = await db.select().from(activityTable)
            .where(inArray(activityTable.sourceAnnouncementId, posts.map(post => post.id)));
          if (linked.some(row => !isCommunityFixtureActivity(row, posts.find(post => post.id === row.sourceAnnouncementId)!))) {
            throw new Error("Non-fixture linked activity; refusing deletion");
          }
          activityIds.push(...linked.map(row => row.id));
        }
        if (activityIds.length) await db.delete(activityTable).where(inArray(activityTable.id, activityIds));
        await db.delete(announcementsTable).where(eq(announcementsTable.actorId, userId));
        await db.delete(usersTable).where(eq(usersTable.clerkId, userId));
      } finally {
        await client.users.deleteUser(userId);
      }
    }
  }
});