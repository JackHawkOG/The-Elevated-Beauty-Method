import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { db, pool, type PoolClient } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../lib/db/src/schema";
import { ensureEnrollmentSchema } from "../lib/ensure-enrollment-schema";
import { requireDevelopmentDatabase } from "./test-development-database";

const migrationUrl = new URL("../../../../lib/db/migrations/0005_unique_enrollments.sql", import.meta.url);

afterAll(async () => {
  await pool.end();
});

test.each(["migration", "startup repair"] as const)(
  "legacy duplicates retain the earliest enrollment, greatest progress and usable lesson on repeated %s",
  assertRepair,
);

async function assertRepair(repair: "migration" | "startup repair") {
  requireDevelopmentDatabase();

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
    // Shadow the live lessons table so the selected lesson IDs are valid
    // without depending on (or changing) development catalog data.
    await client.query(`
      CREATE TEMP TABLE lessons (
        id integer PRIMARY KEY,
        course_id integer NOT NULL,
        published_at timestamp
      )
    `);
    await client.query(`
      INSERT INTO lessons (id, course_id, published_at) VALUES
        (31, 7, '2022-01-01'),
        (32, 7, NULL),
        (41, 7, '2022-01-01'),
        (51, 8, '2022-01-01')
    `);
    await client.query(`
      INSERT INTO enrollments (id, user_id, course_id, completed_lessons, last_lesson_id, enrolled_at)
      VALUES
        (12, 'legacy-member', 7, 4, 31, '2023-06-01'),
        (11, 'legacy-member', 7, 1, NULL, '2022-01-01'),
        (13, 'legacy-member', 7, 8, 32, '2023-07-01'),
        (14, 'legacy-member', 7, 9, 51, '2023-08-01'),
        (22, 'another-member', 7, 5, NULL, '2023-06-01'),
        (21, 'another-member', 7, 2, 41, '2022-01-01'),
        (30, 'legacy-member', 8, 3, 51, '2022-03-01'),
        (61, 'no-valid-lesson', 7, 2, 32, '2022-01-01'),
        (62, 'no-valid-lesson', 7, 8, 51, '2023-01-01'),
        (63, 'no-valid-lesson', 7, 4, NULL, '2024-01-01')
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

    const original = await rows();
    // A deleted legacy row adds two new copies. The DELETE succeeds, but the
    // final unique index cannot be built; neither the merge nor the deletion
    // should survive that failure.
    await client.query(`
      CREATE FUNCTION pg_temp.inject_enrollment_index_conflict() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = 12 THEN
          INSERT INTO enrollments (id, user_id, course_id, enrolled_at)
          VALUES (91, 'index-conflict-member', 7, '2024-01-01'),
                 (92, 'index-conflict-member', 7, '2024-01-01');
        END IF;
        RETURN NULL;
      END
      $$
    `);
    await client.query(`
      CREATE TRIGGER inject_enrollment_index_conflict
      AFTER DELETE ON enrollments FOR EACH ROW
      EXECUTE FUNCTION pg_temp.inject_enrollment_index_conflict()
    `);
    const indexFailure = {
      code: "23505",
      constraint: "enrollments_user_id_course_id_unique",
    };
    await expect(runRepair()).rejects.toMatchObject(
      repair === "migration" ? indexFailure : { cause: indexFailure },
    );
    // A multi-statement SQL migration leaves the session in a failed explicit
    // transaction; the startup repair rolls its transaction back itself.
    await client.query("ROLLBACK");
    expect(await rows()).toEqual(original);
    expect((await client.query(
      "SELECT to_regclass('pg_temp.enrollments_user_id_course_id_unique') AS index_name",
    )).rows[0].index_name).toBeNull();
    await client.query("DROP TRIGGER inject_enrollment_index_conflict ON enrollments");

    await runRepair();
    const merged = await rows();
    expect(merged).toEqual([
      { id: 11, user_id: "legacy-member", course_id: 7, completed_lessons: 9, last_lesson_id: 31, enrolled_at: "2022-01-01" },
      { id: 21, user_id: "another-member", course_id: 7, completed_lessons: 5, last_lesson_id: 41, enrolled_at: "2022-01-01" },
      { id: 30, user_id: "legacy-member", course_id: 8, completed_lessons: 3, last_lesson_id: 51, enrolled_at: "2022-03-01" },
      { id: 61, user_id: "no-valid-lesson", course_id: 7, completed_lessons: 8, last_lesson_id: null, enrolled_at: "2022-01-01" },
    ]);
    // The installed index must prevent future duplicates as well.
    await expect(client.query(`
      INSERT INTO enrollments (id, user_id, course_id, enrolled_at)
      VALUES (40, 'legacy-member', 7, '2024-01-01')
    `)).rejects.toMatchObject({ code: "23505" });
    await runRepair();
    expect(await rows()).toEqual(merged);
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    await client.query("DROP TABLE IF EXISTS pg_temp.enrollments");
    await client.query("DROP TABLE IF EXISTS pg_temp.lessons");
    await client.query("DROP FUNCTION IF EXISTS pg_temp.inject_enrollment_index_conflict()");
    client.release();
  }
}

test("a writer waits for startup repair to merge legacy rows and install uniqueness", async () => {
  requireDevelopmentDatabase();

  // Unlike session-local temp tables, a private schema is visible to both
  // connections. Neither connection resolves the workspace's public tables.
  const schemaName = `enrollment_repair_${randomUUID().replaceAll("-", "")}`;
  const admin = await pool.connect();
  let repairClient: PoolClient | undefined;
  let writerClient: PoolClient | undefined;
  let repairRun: Promise<void> | undefined;
  let writerRun: Promise<unknown> | undefined;
  let resumeRepair: (() => void) | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await admin.query(`
      CREATE TABLE "${schemaName}".enrollments (
        id integer PRIMARY KEY,
        user_id text NOT NULL,
        course_id integer NOT NULL,
        completed_lessons integer NOT NULL DEFAULT 0,
        last_lesson_id integer,
        enrolled_at timestamp NOT NULL
      )
    `);
    await admin.query(`
      CREATE TABLE "${schemaName}".lessons (
        id integer PRIMARY KEY,
        course_id integer NOT NULL,
        published_at timestamp
      )
    `);
    await admin.query(`
      INSERT INTO "${schemaName}".enrollments
        (id, user_id, course_id, completed_lessons, enrolled_at)
      VALUES
        (1, 'member', 7, 1, '2022-01-01'),
        (2, 'member', 7, 4, '2023-01-01')
    `);

    repairClient = await pool.connect();
    writerClient = await pool.connect();
    await repairClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    await writerClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    const { rows: [{ pid: repairPid }] } = await repairClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: [{ pid: writerPid }] } = await writerClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    let signalLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLock = resolve; });
    const pauseAfterLock = new Promise<void>((resolve) => { resumeRepair = resolve; });
    const isolatedDb = drizzle(repairClient, { schema });
    // Pause only after the actual table lock returns, keeping its transaction
    // open until the competing insert is observed waiting in PostgreSQL.
    const instrumentedDb: Pick<typeof db, "transaction"> = {
      transaction: ((callback: Parameters<typeof db.transaction>[0]) =>
        isolatedDb.transaction((tx) => callback(new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "execute") return Reflect.get(target, property, receiver);
            return async (statement: Parameters<typeof tx.execute>[0]) => {
              const result = await target.execute(statement);
              signalLock();
              await pauseAfterLock;
              return result;
            };
          },
        })))) as typeof db.transaction,
    };
    repairRun = ensureEnrollmentSchema(instrumentedDb);
    await Promise.race([
      lockAcquired,
      repairRun.then(() => { throw new Error("Repair completed without acquiring the table lock"); }),
    ]);

    // Convert rejection to a value immediately, so it cannot be unhandled
    // while we verify that the writer is waiting on the repair.
    writerRun = writerClient.query(`
      INSERT INTO enrollments (id, user_id, course_id, enrolled_at)
      VALUES (3, 'member', 7, '2024-01-01')
    `).then(() => ({ code: "inserted" }), (error: { code?: string }) => ({ code: error.code }));

    let blocked = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { rows: [{ waiting }] } = await admin.query<{ waiting: boolean }>(`
        SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS waiting
        FROM pg_stat_activity WHERE pid = $1
      `, [writerPid, repairPid]);
      if (waiting) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked, "writer must wait on the repair's table lock").toBe(true);
    resumeRepair!();
    await repairRun;
    expect(await writerRun).toEqual({ code: "23505" });

    expect((await admin.query(`
      SELECT id, completed_lessons FROM "${schemaName}".enrollments
      WHERE user_id = 'member' AND course_id = 7
    `)).rows).toEqual([{ id: 1, completed_lessons: 4 }]);
    expect((await admin.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND indexname = 'enrollments_user_id_course_id_unique'
    `, [schemaName])).rows).toHaveLength(1);
  } finally {
    resumeRepair?.();
    await Promise.allSettled([repairRun, writerRun].filter((promise) => promise !== undefined));
    if (repairClient) {
      await repairClient.query("RESET search_path");
      repairClient.release();
    }
    if (writerClient) {
      await writerClient.query("RESET search_path");
      writerClient.release();
    }
    if (created) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    admin.release();
  }
}, 15000);

test("a writer waits for the SQL migration to merge legacy rows and install uniqueness", async () => {
  requireDevelopmentDatabase();

  // The migration's unqualified names resolve to this shared private schema,
  // never to the workspace's public enrollments table or its index.
  const schemaName = `enrollment_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = await pool.connect();
  let migrationClient: PoolClient | undefined;
  let writerClient: PoolClient | undefined;
  let migrationRun: Promise<unknown> | undefined;
  let writerRun: Promise<unknown> | undefined;
  let gateHeld = false;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await admin.query(`
      CREATE TABLE "${schemaName}".enrollments (
        id integer PRIMARY KEY,
        user_id text NOT NULL,
        course_id integer NOT NULL,
        completed_lessons integer NOT NULL DEFAULT 0,
        last_lesson_id integer,
        enrolled_at timestamp NOT NULL
      )
    `);
    await admin.query(`
      CREATE TABLE "${schemaName}".lessons (
        id integer PRIMARY KEY,
        course_id integer NOT NULL,
        published_at timestamp
      )
    `);
    await admin.query(`
      INSERT INTO "${schemaName}".enrollments
        (id, user_id, course_id, completed_lessons, enrolled_at)
      VALUES (1, 'member', 7, 1, '2022-01-01'),
             (2, 'member', 7, 4, '2023-01-01')
    `);
    // Hold the migration inside its UPDATE, which follows LOCK TABLE in the
    // real script. The gate only affects this private schema's legacy row.
    await admin.query(`
      CREATE FUNCTION "${schemaName}".pause_migration() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA));
        RETURN NEW;
      END
      $$
    `);
    await admin.query(`
      CREATE TRIGGER pause_migration BEFORE UPDATE ON "${schemaName}".enrollments
      FOR EACH ROW EXECUTE FUNCTION "${schemaName}".pause_migration()
    `);
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [schemaName]);
    gateHeld = true;

    migrationClient = await pool.connect();
    writerClient = await pool.connect();
    await migrationClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    await writerClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    const { rows: [{ pid: adminPid }] } = await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: [{ pid: migrationPid }] } = await migrationClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: [{ pid: writerPid }] } = await writerClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    const migration = await readFile(migrationUrl, "utf8");
    migrationRun = migrationClient.query(migration).then(
      () => ({ code: "committed" }),
      (error: { code?: string }) => ({ code: error.code }),
    );
    const waitUntilBlockedBy = async (pid: number, blocker: number) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { rows: [{ waiting }] } = await admin.query<{ waiting: boolean }>(`
          SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS waiting
          FROM pg_stat_activity WHERE pid = $1
        `, [pid, blocker]);
        if (waiting) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    expect(await waitUntilBlockedBy(migrationPid, adminPid),
      "migration must pause after acquiring its table lock").toBe(true);

    writerRun = writerClient.query(`
      INSERT INTO enrollments (id, user_id, course_id, enrolled_at)
      VALUES (3, 'member', 7, '2024-01-01')
    `).then(() => ({ code: "inserted" }), (error: { code?: string }) => ({ code: error.code }));
    expect(await waitUntilBlockedBy(writerPid, migrationPid),
      "writer must wait on the migration's table lock").toBe(true);
    await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [schemaName]);
    gateHeld = false;

    expect(await migrationRun).toEqual({ code: "committed" });
    expect(await writerRun).toEqual({ code: "23505" });
    expect((await admin.query(`
      SELECT id, completed_lessons FROM "${schemaName}".enrollments
      WHERE user_id = 'member' AND course_id = 7
    `)).rows).toEqual([{ id: 1, completed_lessons: 4 }]);
    expect((await admin.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND indexname = 'enrollments_user_id_course_id_unique'
    `, [schemaName])).rows).toHaveLength(1);
  } finally {
    if (gateHeld) await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [schemaName]);
    await Promise.allSettled([migrationRun, writerRun].filter((promise) => promise !== undefined));
    if (migrationClient) {
      await migrationClient.query("ROLLBACK");
      await migrationClient.query("RESET search_path");
      migrationClient.release();
    }
    if (writerClient) {
      await writerClient.query("RESET search_path");
      writerClient.release();
    }
    if (created) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    admin.release();
  }
}, 15000);

test("two startup repairs serialize on the same legacy enrollments", async () => {
  requireDevelopmentDatabase();

  // A private schema is shared across connections, while both repair sessions
  // resolve unqualified tables and the index outside the public schema.
  const schemaName = `enrollment_repair_${randomUUID().replaceAll("-", "")}`;
  const admin = await pool.connect();
  let firstClient: PoolClient | undefined;
  let secondClient: PoolClient | undefined;
  let firstRun: Promise<void> | undefined;
  let secondRun: Promise<void> | undefined;
  let resumeFirst: (() => void) | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await admin.query(`
      CREATE TABLE "${schemaName}".enrollments (
        id integer PRIMARY KEY,
        user_id text NOT NULL,
        course_id integer NOT NULL,
        completed_lessons integer NOT NULL DEFAULT 0,
        last_lesson_id integer,
        enrolled_at timestamp NOT NULL
      )
    `);
    await admin.query(`
      CREATE TABLE "${schemaName}".lessons (
        id integer PRIMARY KEY,
        course_id integer NOT NULL,
        published_at timestamp
      )
    `);
    await admin.query(`
      INSERT INTO "${schemaName}".lessons (id, course_id, published_at)
      VALUES (31, 7, '2022-01-01')
    `);
    await admin.query(`
      INSERT INTO "${schemaName}".enrollments
        (id, user_id, course_id, completed_lessons, last_lesson_id, enrolled_at)
      VALUES
        (1, 'member', 7, 1, NULL, '2022-01-01'),
        (2, 'member', 7, 4, 31, '2023-01-01')
    `);

    firstClient = await pool.connect();
    secondClient = await pool.connect();
    await firstClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    await secondClient.query("SELECT set_config('search_path', $1, false)", [schemaName]);
    const { rows: [{ firstPid }] } = await firstClient.query<{ firstPid: number }>(
      'SELECT pg_backend_pid() AS "firstPid"',
    );
    const { rows: [{ secondPid }] } = await secondClient.query<{ secondPid: number }>(
      'SELECT pg_backend_pid() AS "secondPid"',
    );

    let signalLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLock = resolve; });
    const pauseAfterLock = new Promise<void>((resolve) => { resumeFirst = resolve; });
    const isolatedDb = drizzle(firstClient, { schema });
    const pausedDb: Pick<typeof db, "transaction"> = {
      transaction: ((callback: Parameters<typeof db.transaction>[0]) =>
        isolatedDb.transaction((tx) => callback(new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== "execute") return Reflect.get(target, property, receiver);
            return async (statement: Parameters<typeof tx.execute>[0]) => {
              const result = await target.execute(statement);
              signalLock();
              await pauseAfterLock;
              return result;
            };
          },
        })))) as typeof db.transaction,
    };

    firstRun = ensureEnrollmentSchema(pausedDb);
    await Promise.race([
      lockAcquired,
      firstRun.then(() => { throw new Error("First repair finished before taking the table lock"); }),
    ]);
    // Attach a rejection handler immediately so a premature failure cannot
    // become unhandled while checking that PostgreSQL is blocking the second.
    secondRun = ensureEnrollmentSchema(drizzle(secondClient, { schema }));
    const secondOutcome = secondRun.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    let blocked = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { rows: [{ waiting }] } = await admin.query<{ waiting: boolean }>(`
        SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS waiting
        FROM pg_stat_activity WHERE pid = $1
      `, [secondPid, firstPid]);
      if (waiting) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked, "second repair must wait for the first repair's table lock").toBe(true);
    resumeFirst!();
    await firstRun;
    expect(await secondOutcome).toEqual({ status: "fulfilled" });

    expect((await admin.query(`
      SELECT id, completed_lessons, last_lesson_id
      FROM "${schemaName}".enrollments WHERE user_id = 'member' AND course_id = 7
    `)).rows).toEqual([{ id: 1, completed_lessons: 4, last_lesson_id: 31 }]);
    expect((await admin.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND indexname = 'enrollments_user_id_course_id_unique'
    `, [schemaName])).rows).toHaveLength(1);
    await expect(admin.query(`
      INSERT INTO "${schemaName}".enrollments (id, user_id, course_id, enrolled_at)
      VALUES (3, 'member', 7, '2024-01-01')
    `)).rejects.toMatchObject({ code: "23505" });
  } finally {
    resumeFirst?.();
    await Promise.allSettled([firstRun, secondRun].filter((promise) => promise !== undefined));
    if (firstClient) {
      await firstClient.query("RESET search_path");
      firstClient.release();
    }
    if (secondClient) {
      await secondClient.query("RESET search_path");
      secondClient.release();
    }
    if (created) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    admin.release();
  }
}, 15000);
