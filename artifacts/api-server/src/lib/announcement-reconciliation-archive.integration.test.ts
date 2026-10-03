import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type PoolClient } from "@workspace/db";
import * as schema from "../../../../lib/db/src/schema";
import { requireDevelopmentDatabase } from "../routes/test-development-database";
import { reconcileAnnouncementActivity } from "./reconcile-announcement-activity";

afterAll(async () => { await pool.end(); });

async function withArchive(callback: (client: PoolClient, database: NonNullable<Parameters<typeof reconcileAnnouncementActivity>[0]>) => Promise<void>) {
  requireDevelopmentDatabase();
  const client = await pool.connect();
  const name = `announcement_archive_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${name}"`);
    created = true;
    // No public fallback; repair cannot touch existing announcements.
    await client.query("SELECT set_config('search_path', $1, false)", [name]);
    await client.query(`
      CREATE TABLE announcements (
        id serial PRIMARY KEY, title text NOT NULL, body text NOT NULL,
        author_name text NOT NULL, actor_id text, request_key text,
        pinned boolean NOT NULL DEFAULT false, created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE activity (
        id serial PRIMARY KEY, type text NOT NULL, description text NOT NULL,
        actor_name text NOT NULL, entity_title text NOT NULL,
        source_announcement_id integer UNIQUE REFERENCES announcements(id),
        source_evidence text, source_reviewed_by text, source_reviewed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE announcement_activity_corrections (
        from_announcement_id integer, to_announcement_id integer
      );
      INSERT INTO announcements (title, body, author_name) VALUES
        ('Missing', 'Legacy post', 'Original'), ('Review', 'Ambiguous post', 'Original');
      INSERT INTO activity (type, description, actor_name, entity_title) VALUES
        ('announcement', 'posted an announcement', 'Different', 'Review');
    `);
    await client.query(await readFile(new URL("../../../../lib/db/migrations/0026_announcement_reconciliation_runs.sql", import.meta.url), "utf8"));
    await callback(client, drizzle(client, { schema }));
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    if (created) await client.query(`DROP SCHEMA "${name}" CASCADE`);
    client.release();
  }
}

test("committed repair and review survive an empty later run and deletion of source records", async () => {
  await withArchive(async (client, database) => {
    const first = await reconcileAnnouncementActivity(database);
    expect(first).toEqual({
      repairedIds: [1],
      review: [{ announcementId: 2, activityIds: [1], reason: "feed entry has a different author or timestamp" }],
    });
    const original = (await client.query("SELECT * FROM announcement_reconciliation_runs")).rows[0];
    expect(original).toMatchObject({ version: 1, repaired_ids: first.repairedIds, review: first.review });
    expect(original.recorded_at).toBeInstanceOf(Date);
    // Resolve review independently, then verify the truly empty next run.
    await client.query("UPDATE activity SET source_announcement_id = 2 WHERE id = 1");
    expect(await reconcileAnnouncementActivity(database)).toEqual({ repairedIds: [], review: [] });
    const runs = (await client.query("SELECT * FROM announcement_reconciliation_runs ORDER BY id")).rows;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(original);
    expect(runs[1]).toMatchObject({ repaired_ids: [], review: [] });
    expect(runs[1].id).toBeGreaterThan(runs[0].id);
    expect((await client.query("SELECT count(*)::integer AS count FROM activity")).rows[0].count).toBe(2);
    await client.query("DELETE FROM activity; DELETE FROM announcements");
    expect((await client.query("SELECT * FROM announcement_reconciliation_runs ORDER BY id")).rows).toEqual(runs);
  });
});

test("archive failure rolls repairs back, and a later retry archives the still-missing repair", async () => {
  await withArchive(async (client, database) => {
    await client.query(`ALTER TABLE announcement_reconciliation_runs ADD CONSTRAINT reject_archive CHECK (false)`);
    await expect(reconcileAnnouncementActivity(database)).rejects.toThrow();
    expect((await client.query("SELECT * FROM announcement_reconciliation_runs")).rows).toEqual([]);
    expect((await client.query("SELECT * FROM activity WHERE source_announcement_id = 1")).rows).toEqual([]);
    await client.query("ALTER TABLE announcement_reconciliation_runs DROP CONSTRAINT reject_archive");
    expect((await reconcileAnnouncementActivity(database)).repairedIds).toEqual([1]);
    const rows = (await client.query("SELECT * FROM announcement_reconciliation_runs")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].repaired_ids).toEqual([1]);
  });
});