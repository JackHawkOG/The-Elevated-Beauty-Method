import { readFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { pool } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../lib/db/src/schema";
import { ensureEnrollmentSchema } from "../lib/ensure-enrollment-schema";

const migrationUrl = new URL("../../../../lib/db/migrations/0005_unique_enrollments.sql", import.meta.url);

afterAll(async () => {
  await pool.end();
});

test.each(["migration", "startup repair"] as const)(
  "legacy duplicates retain the earliest enrollment, greatest progress and usable lesson on repeated %s",
  assertRepair,
);

async function assertRepair(repair: "migration" | "startup repair") {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT || !process.env.DATABASE_URL) {
    throw new Error("Enrollment migration test requires a development database");
  }
  const target = new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGPORT || !process.env.PGDATABASE ||
      target.hostname !== process.env.PGHOST ||
      (target.port || "5432") !== process.env.PGPORT ||
      decodeURIComponent(target.pathname.slice(1)) !== process.env.PGDATABASE) {
    throw new Error("Enrollment migration test requires the workspace development database URL");
  }

  const client = await pool.connect();
  try {
    // A session-local copy of the legacy columns has no unique index. Both
    // repairs' unqualified table/index names resolve only to this temp table.
    await client.query(`
      CREATE TEMP TABLE enrollments (
        id integer PRIMARY KEY,
        user_id text NOT NULL,
        course_id integer NOT NULL,
        completed_lessons integer NOT NULL DEFAULT 0,
        last_lesson_id integer,
        enrolled_at timestamp NOT NULL
      )
    `);
    await client.query("SET search_path TO pg_temp, public");
    await client.query(`
      INSERT INTO enrollments (id, user_id, course_id, completed_lessons, last_lesson_id, enrolled_at)
      VALUES
        (12, 'legacy-member', 7, 4, 31, '2023-06-01'),
        (11, 'legacy-member', 7, 1, NULL, '2022-01-01'),
        (22, 'another-member', 7, 5, NULL, '2023-06-01'),
        (21, 'another-member', 7, 2, 41, '2022-01-01'),
        (30, 'legacy-member', 8, 3, 51, '2022-03-01')
    `);
    const migration = await readFile(migrationUrl, "utf8");
    const rows = async () => (await client.query(`
      SELECT id, user_id, course_id, completed_lessons, last_lesson_id,
        enrolled_at::date::text AS enrolled_at
      FROM enrollments ORDER BY id
    `)).rows;

    const runRepair = async () => {
      if (repair === "migration") {
        await client.query(migration);
      } else {
        await ensureEnrollmentSchema(drizzle(client, { schema }));
      }
    };

    await runRepair();
    const merged = await rows();
    expect(merged).toEqual([
      { id: 11, user_id: "legacy-member", course_id: 7, completed_lessons: 4, last_lesson_id: 31, enrolled_at: "2022-01-01" },
      { id: 21, user_id: "another-member", course_id: 7, completed_lessons: 5, last_lesson_id: 41, enrolled_at: "2022-01-01" },
      { id: 30, user_id: "legacy-member", course_id: 8, completed_lessons: 3, last_lesson_id: 51, enrolled_at: "2022-03-01" },
    ]);
    // The installed index must prevent future duplicates as well.
    await expect(client.query(`
      INSERT INTO enrollments (id, user_id, course_id, enrolled_at)
      VALUES (40, 'legacy-member', 7, '2024-01-01')
    `)).rejects.toMatchObject({ code: "23505" });
    await runRepair();
    expect(await rows()).toEqual(merged);
  } finally {
    await client.query("RESET search_path");
    await client.query("DROP TABLE IF EXISTS pg_temp.enrollments");
    client.release();
  }
}