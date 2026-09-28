import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { cleanupCommunityFixtures } from "./community-fixtures-cleanup-core";
import {
  communityFixtureEmail, communityFixturePrivateMetadata, newCommunityFixtureTag,
  requireCommunityDevelopment,
} from "./community-fixtures";

it("keeps unrelated community rows and refuses malformed rows during database cleanup", async () => {
  // This test must never touch a production database. The fake Clerk identity is never created remotely.
  requireCommunityDevelopment();
  const { db, pool } = await import("../../../lib/db/src/index");
  const tag = newCommunityFixtureTag();
  const ownerId = `community-cleanup-${randomUUID()}`;
  const otherId = `community-bystander-${randomUUID()}`;
  const email = communityFixtureEmail(tag);
  const identity = {
    id: ownerId,
    emailAddresses: [{ emailAddress: email }],
    privateMetadata: communityFixturePrivateMetadata,
    firstName: "Community",
    lastName: "Check",
    createdAt: Date.now() - 26 * 60 * 60 * 1000,
  };
  const bystander = {
    ...identity, id: otherId, privateMetadata: {},
    emailAddresses: [{ emailAddress: `${otherId}@example.invalid` }],
  };
  const client = {
    getUserList: vi.fn(async () => ({ data: [identity, bystander], totalCount: 2 })),
    getUser: vi.fn(async (id: string) => {
      if (id !== ownerId) throw new Error(`Unexpected Clerk lookup: ${id}`);
      return identity;
    }),
    deleteUser: vi.fn(async (id: string) => {
      if (id !== ownerId) throw new Error(`Unexpected Clerk deletion: ${id}`);
    }),
  };
  const ownedKey = randomUUID();
  const otherKey = randomUUID();
  let ownedPostId: number | undefined;
  let otherPostId: number | undefined;
  let malformedPostId: number | undefined;

  async function counts() {
    const [members, posts, activities] = await Promise.all([
      pool.query<{ clerk_id: string }>("SELECT clerk_id FROM users WHERE clerk_id = ANY($1::text[]) ORDER BY clerk_id", [[ownerId, otherId]]),
      pool.query<{ id: number }>("SELECT id FROM announcements WHERE actor_id = ANY($1::text[]) ORDER BY id", [[ownerId, otherId]]),
      pool.query<{ id: number }>("SELECT id FROM activity WHERE source_announcement_id = ANY($1::int[]) ORDER BY id", [[ownedPostId, otherPostId].filter((id): id is number => id !== undefined)]),
    ]);
    return { members: members.rows.map(row => row.clerk_id), posts: posts.rows.map(row => row.id), activities: activities.rows.map(row => row.id) };
  }

  try {
    await pool.query("INSERT INTO users (clerk_id, display_name, email, membership_tier) VALUES ($1, 'Community Check', $2, 'Free'), ($3, 'Unrelated Member', $4, 'Free')",
      [ownerId, email, otherId, `${otherId}@example.invalid`]);
    const owned = await pool.query<{ id: number }>(
      "INSERT INTO announcements (actor_id, title, body, author_name, request_key) VALUES ($1, $2, $3, 'Community Check', $4) RETURNING id",
      [ownerId, `Community retry ${tag}`, `Message ${tag}`, ownedKey]);
    ownedPostId = owned.rows[0].id;
    const other = await pool.query<{ id: number }>(
      "INSERT INTO announcements (actor_id, title, body, author_name, request_key) VALUES ($1, $2, $3, 'Unrelated Member', $4) RETURNING id",
      [otherId, `Community retry ${tag}`, `Message ${tag}`, otherKey]);
    otherPostId = other.rows[0].id;
    await pool.query(
      "INSERT INTO activity (type, description, actor_name, entity_title, source_announcement_id) VALUES ('announcement', 'posted an announcement', 'Community Check', $1, $2), ('announcement', 'posted an announcement', 'Unrelated Member', $1, $3)",
      [`Community retry ${tag}`, ownedPostId, otherPostId]);
    const initial = await counts();
    expect(initial.members).toHaveLength(2);
    expect(initial.posts).toHaveLength(2);
    expect(initial.activities).toHaveLength(2);

    await cleanupCommunityFixtures({ client, db, deleteRows: false });
    expect(await counts()).toEqual(initial);
    expect(client.deleteUser).not.toHaveBeenCalled();

    const malformed = await pool.query<{ id: number }>(
      "INSERT INTO announcements (actor_id, title, body, author_name, request_key) VALUES ($1, 'Real announcement', 'Member content', 'Community Check', $2) RETURNING id",
      [ownerId, randomUUID()]);
    malformedPostId = malformed.rows[0].id;
    await expect(cleanupCommunityFixtures({ client, db, deleteRows: true })).rejects.toThrow("Non-fixture announcement");
    expect(await counts()).toEqual({ ...initial, posts: [...initial.posts, malformedPostId].sort((a, b) => a - b) });
    expect(client.deleteUser).not.toHaveBeenCalled();
    await pool.query("DELETE FROM announcements WHERE id = $1", [malformedPostId]);
    malformedPostId = undefined;

    await pool.query("UPDATE activity SET entity_title = 'Other content' WHERE source_announcement_id = $1", [ownedPostId]);
    await expect(cleanupCommunityFixtures({ client, db, deleteRows: true })).rejects.toThrow("Non-fixture activity");
    expect(await counts()).toEqual(initial);
    expect(client.deleteUser).not.toHaveBeenCalled();
    await pool.query("UPDATE activity SET entity_title = $1 WHERE source_announcement_id = $2", [`Community retry ${tag}`, ownedPostId]);

    await cleanupCommunityFixtures({ client, db, deleteRows: true });
    expect(await counts()).toEqual({ members: [otherId], posts: [otherPostId], activities: initial.activities.slice(1) });
    expect(client.getUser).toHaveBeenCalledWith(ownerId);
    expect(client.deleteUser).toHaveBeenCalledExactlyOnceWith(ownerId);
  } finally {
    // Exact IDs only: never clean up rows belonging to an existing account or another test.
    const ids = [ownedPostId, otherPostId, malformedPostId].filter((id): id is number => id !== undefined);
    await pool.query("DELETE FROM activity WHERE source_announcement_id = ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM announcements WHERE id = ANY($1::int[])", [ids]);
    await pool.query("DELETE FROM users WHERE clerk_id = ANY($1::text[])", [[ownerId, otherId]]);
  }
}, 30_000);