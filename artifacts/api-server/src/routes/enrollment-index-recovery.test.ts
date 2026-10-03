import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { pool, type PoolClient } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../lib/db/src/schema";
import { ensureEnrollmentSchema } from "../lib/ensure-enrollment-schema";
import { requireDevelopmentDatabase } from "./test-development-database";

const operation = (name: string) => readFile(
  new URL(`../../../../lib/db/operations/${name}.sql`, import.meta.url), "utf8",
);
const migration = () => readFile(
  new URL("../../../../lib/db/migrations/0005_unique_enrollments.sql", import.meta.url), "utf8",
);

afterAll(async () => { await pool.end(); });

async function withLegacySchema(callback: (client: PoolClient, name: string) => Promise<void>) {
  requireDevelopmentDatabase();
  const client = await pool.connect();
  const name = `enrollment_recovery_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${name}"`);
    created = true;
    // No public fallback: all fixture objects and SQL operations are isolated.
    await client.query("SELECT set_config('search_path', $1, false)", [name]);
    await client.query(`
      CREATE TABLE enrollments (
        id serial PRIMARY KEY, user_id text NOT NULL, course_id integer NOT NULL,
        completed_lessons integer NOT NULL DEFAULT 0, last_lesson_id integer,
        enrolled_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT progress_nonnegative CHECK (completed_lessons >= 0)
      );
      CREATE TABLE lessons (
        id integer PRIMARY KEY, course_id integer NOT NULL, published_at timestamp
      );
      INSERT INTO lessons VALUES (31, 7, '2022-01-01');
      INSERT INTO enrollments
        (id, user_id, course_id, completed_lessons, last_lesson_id, enrolled_at)
      VALUES (1, 'member', 7, 1, NULL, '2022-01-01'),
             (2, 'member', 7, 4, 31, '2023-01-01');
    `);
    await callback(client, name);
  } finally {
    await client.query("ROLLBACK");
    await client.query("RESET search_path");
    if (created) await client.query(`DROP SCHEMA "${name}" CASCADE`);
    client.release();
  }
}

async function repair(client: PoolClient, kind: "migration" | "startup repair") {
  if (kind === "migration") await client.query(await migration());
  else await ensureEnrollmentSchema(drizzle(client, { schema }));
}

const rows = async (client: PoolClient) => (await client.query(`
  SELECT id, completed_lessons, last_lesson_id, enrolled_at::date::text AS enrolled_at
  FROM enrollments ORDER BY id
`)).rows;

test.each([
  ["migration", "standalone"],
  ["startup repair", "standalone"],
  ["migration", "constraint-owned"],
  ["startup repair", "constraint-owned"],
] as const)("operator recovery via %s preserves a %s index and dependencies", async (kind, ownership) => {
  requireDevelopmentDatabase();
  await withLegacySchema(async (client) => {
    if (ownership === "standalone") {
      await client.query("CREATE INDEX enrollments_user_id_course_id_unique ON enrollments (user_id, course_id)");
    } else {
      await client.query(`
        ALTER TABLE enrollments ADD CONSTRAINT enrollments_user_id_course_id_unique
          UNIQUE (user_id, course_id, id);
        CREATE TABLE enrollment_references (
          user_id text, course_id integer, enrollment_id integer,
          CONSTRAINT preserve_enrollment_reference FOREIGN KEY (user_id, course_id, enrollment_id)
            REFERENCES enrollments (user_id, course_id, id)
        );
        INSERT INTO enrollment_references VALUES ('member', 7, 1);
      `);
    }
    const legacyOid = (await client.query(
      "SELECT 'enrollments_user_id_course_id_unique'::regclass::oid AS oid",
    )).rows[0].oid;
    const dependencies = async () => (await client.query(`
      SELECT classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype
      FROM pg_depend
      WHERE (classid = 'pg_class'::regclass AND objid = $1)
         OR (refclassid = 'pg_class'::regclass AND refobjid = $1)
      ORDER BY classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype
    `, [legacyOid])).rows;
    const constraints = async () => (await client.query(`
      SELECT oid, contype, conrelid, confrelid, conindid, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'enrollments'::regclass OR conindid = $1
      ORDER BY oid
    `, [legacyOid])).rows;
    const originalRows = await rows(client);
    const originalDependencies = await dependencies();
    const originalConstraints = await constraints();
    // Execute the documented read-only inspection, including both dependency directions.
    const inspected = await client.query(await operation("inspect-enrollment-index"));
    expect(inspected).toHaveLength(6);
    await expect(repair(client, kind)).rejects.toMatchObject(kind === "migration"
      ? { code: "P0001" } : { cause: { code: "P0001" } });
    await client.query("ROLLBACK");
    expect(await rows(client)).toEqual(originalRows);

    await client.query(await operation("rename-incompatible-enrollment-index"));
    expect((await client.query(
      "SELECT 'enrollments_user_id_course_id_legacy'::regclass::oid AS oid",
    )).rows[0].oid).toBe(legacyOid);
    expect(await dependencies()).toEqual(originalDependencies);
    expect(await constraints()).toEqual(originalConstraints);
    if (ownership === "constraint-owned") {
      expect((await client.query(
        "SELECT conname FROM pg_constraint WHERE conrelid = 'enrollments'::regclass AND conindid = $1",
        [legacyOid],
      )).rows).toEqual([{ conname: "enrollments_user_id_course_id_legacy" }]);
    }
    await repair(client, kind);
    expect(await rows(client)).toEqual([{
      id: 1, completed_lessons: 4, last_lesson_id: 31, enrolled_at: "2022-01-01",
    }]);
    expect(await dependencies()).toEqual(originalDependencies);
    expect(await constraints()).toEqual(originalConstraints);
    if (ownership === "constraint-owned") {
      expect((await client.query("SELECT * FROM enrollment_references")).rows)
        .toEqual([{ user_id: "member", course_id: 7, enrollment_id: 1 }]);
      await expect(client.query("INSERT INTO enrollment_references VALUES ('member', 7, 999)"))
        .rejects.toMatchObject({ code: "23503" });
    }
    const sequenceBefore = (await client.query("SELECT last_value, is_called FROM enrollments_id_seq")).rows;
    const recoveredRows = await rows(client);
    await client.query(await operation("verify-enrollment-index-recovery"));
    expect(await rows(client)).toEqual(recoveredRows);
    expect((await client.query("SELECT last_value, is_called FROM enrollments_id_seq")).rows).toEqual(sequenceBefore);
    await expect(client.query(`
      INSERT INTO enrollments (id, user_id, course_id) VALUES (3, 'member', 7)
    `)).rejects.toMatchObject({ code: "23505", constraint: "enrollments_user_id_course_id_unique" });
    await repair(client, kind);
    expect(await rows(client)).toEqual(recoveredRows);
    await expect(client.query(await operation("rename-incompatible-enrollment-index")))
      .rejects.toMatchObject({ message: expect.stringContaining("already enforces") });
    await client.query("ROLLBACK");
    expect(await constraints()).toEqual(originalConstraints);
  });
});

// Read the runbook, rather than maintaining a second copy of its psql commands.
// The shell's only "resume" action writes a disposable marker, never starts an API.
async function runPsqlRecovery(name: string, retry = false) {
  requireDevelopmentDatabase();
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const runbook = await readFile(join(root, "docs/enrollment-index-recovery.md"), "utf8");
  const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map(match => match[1]);
  expect(blocks).toHaveLength(3);
  const input = blocks.map((block, i) =>
    i === 1 && retry ? "" :
    `${block.replace("\\set enrollment_schema public", `\\set enrollment_schema ${name}`)
      .replace('SET search_path TO :"enrollment_schema";', 'SET search_path TO :"enrollment_schema";\nSHOW search_path;')}
\\echo RECOVERY_STEP_${i}_FINISHED
`,
  ).join("\n") + "\n\\echo RECOVERY_VERIFICATION_FINISHED\n";
  const directory = await mkdtemp(join(tmpdir(), "enrollment-psql-"));
  const marker = join(directory, "resumed");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PGOPTIONS: "", PGCONNECT_TIMEOUT: "5" };
    // libpq treats even an empty PGSERVICEFILE as a file to open.
    delete env.PGSERVICE;
    delete env.PGSERVICEFILE;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("bash", [
        "-c", 'psql -X -f - && printf "resumed" > "$1"', "recovery-test", marker,
      ], {
        cwd: root,
        // Use the PG* target already checked against the development URL.
        // Never pass credentials on the command line or print this environment.
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.on("error", error => {
        // psql may close its input immediately on a command failure.
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
      });
      child.stdin.end(input);
    });
    const resumed = await access(marker).then(() => true, () => false);
    return { ...result, resumed };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const privateIndexes = async (client: PoolClient) => (await client.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = current_schema() ORDER BY indexname
`)).rows;

test("psql ON_ERROR_STOP stops after a refused rename, without merging or resuming", async () => {
  await withLegacySchema(async (client, name) => {
    await client.query(`
      CREATE INDEX enrollments_user_id_course_id_unique ON enrollments (course_id);
      CREATE INDEX enrollments_user_id_course_id_legacy ON enrollments (user_id);
    `);
    const before = { rows: await rows(client), indexes: await privateIndexes(client) };
    const result = await runPsqlRecovery(name);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("Legacy destination name is occupied");
    expect(result.stdout).toContain("RECOVERY_STEP_0_FINISHED");
    expect(result.stdout).not.toContain("RECOVERY_STEP_1_FINISHED");
    expect(result.stdout).not.toContain("RECOVERY_VERIFICATION_FINISHED");
    expect(result.resumed).toBe(false);
    expect({ rows: await rows(client), indexes: await privateIndexes(client) }).toEqual(before);
  });
});

test("psql stops after a failed merge, rolls back progress, and retries without renaming again", async () => {
  await withLegacySchema(async (client, name) => {
    await client.query(`
      ALTER TABLE enrollments ADD CONSTRAINT enrollments_user_id_course_id_unique
        UNIQUE (user_id, course_id, id);
      CREATE TABLE enrollment_references (
        user_id text, course_id integer, enrollment_id integer,
        FOREIGN KEY (user_id, course_id, enrollment_id)
          REFERENCES enrollments (user_id, course_id, id)
      );
      INSERT INTO enrollment_references VALUES ('member', 7, 2);
    `);
    const before = await rows(client);
    const result = await runPsqlRecovery(name);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("violates foreign key constraint");
    expect(result.stdout).toContain("RECOVERY_STEP_1_FINISHED");
    expect(result.stdout).not.toContain("RECOVERY_VERIFICATION_FINISHED");
    expect(result.stderr).not.toContain("Duplicate enrollments remain");
    expect(result.resumed).toBe(false);
    expect(await rows(client)).toEqual(before);
    expect((await client.query("SELECT * FROM enrollment_references")).rows)
      .toEqual([{ user_id: "member", course_id: 7, enrollment_id: 2 }]);
    expect((await privateIndexes(client)).map(row => row.indexname))
      .toEqual(["enrollments_pkey", "enrollments_user_id_course_id_legacy", "lessons_pkey"]);
    // Separately approved reassignment, only in this disposable fixture.
    await client.query("UPDATE enrollment_references SET enrollment_id = 1");
    const retried = await runPsqlRecovery(name, true);
    expect(retried.code).toBe(0);
    expect(retried.stdout).not.toContain("RECOVERY_STEP_1_FINISHED");
    expect(retried.stderr).toContain("Enrollment recovery verified:");
    expect(retried.resumed).toBe(true);
    expect(await rows(client)).toEqual([{
      id: 1, completed_lessons: 4, last_lesson_id: 31, enrolled_at: "2022-01-01",
    }]);
  });
});

test.each(["missing table", "missing schema"] as const)(
  "psql keeps the selected schema without public fallback when there is a %s", async (missing) => {
    await withLegacySchema(async (client, name) => {
      const before = await rows(client);
      // The inspection's first read fails before any destructive script runs.
      if (missing === "missing table") {
        await client.query("ALTER TABLE enrollments RENAME TO private_enrollments");
      }
      const selected = missing === "missing schema" ? `${name}_absent` : name;
      const result = await runPsqlRecovery(selected);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('relation "enrollments" does not exist');
      expect(result.stdout).toMatch(new RegExp(`search_path\\s+-+\\s+${selected}\\s`));
      expect(result.stdout).not.toContain("RECOVERY_STEP_0_FINISHED");
      expect(result.resumed).toBe(false);
      if (missing === "missing table") {
        await client.query("ALTER TABLE private_enrollments RENAME TO enrollments");
      }
      expect(await rows(client)).toEqual(before);
    });
  },
);

test.each([false, true])(
  "psql permits scripted resume only after verification succeeds (probe blocked: %s)", async (blocked) => {
    await withLegacySchema(async (client, name) => {
      await client.query("CREATE INDEX enrollments_user_id_course_id_unique ON enrollments (course_id)");
      if (blocked) {
        await client.query(`
          CREATE FUNCTION reject_probe() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            UPDATE enrollments SET completed_lessons = 99 WHERE id = 1;
            RAISE unique_violation USING CONSTRAINT = 'unrelated_legacy_constraint';
          END $$;
          CREATE TRIGGER reject_probe BEFORE INSERT ON enrollments
            FOR EACH ROW EXECUTE FUNCTION reject_probe();
        `);
      }
      const sequenceBefore = (await client.query("SELECT last_value, is_called FROM enrollments_id_seq")).rows;
      const result = await runPsqlRecovery(name);
      expect(result.stdout).toMatch(new RegExp(`search_path\\s+-+\\s+${name}\\s`));
      expect(result.stdout).toContain(name);
      expect(result.stdout).toContain("RECOVERY_STEP_1_FINISHED");
      expect(result.code).toBe(blocked ? 3 : 0);
      expect(result.resumed).toBe(!blocked);
      if (blocked) {
        expect(result.stderr).toContain("Duplicate probe rejected by unexpected constraint: unrelated_legacy_constraint");
        expect(result.stdout).not.toContain("RECOVERY_VERIFICATION_FINISHED");
      } else {
        expect(result.stderr).toContain("Enrollment recovery verified: no duplicates; duplicate probe rejected by the expected index");
        expect(result.stdout).toContain("RECOVERY_VERIFICATION_FINISHED");
      }
      // Merge committed, but verification's probe and trigger writes never persist.
      expect(await rows(client)).toEqual([{
        id: 1, completed_lessons: 4, last_lesson_id: 31, enrolled_at: "2022-01-01",
      }]);
      expect((await client.query("SELECT last_value, is_called FROM enrollments_id_seq")).rows).toEqual(sequenceBefore);
    });
  },
);

test("unsafe rename targets and occupied legacy names leave all rows and indexes intact", async () => {
  requireDevelopmentDatabase();
  await withLegacySchema(async (client) => {
    const originalRows = await rows(client);
    const rename = await operation("rename-incompatible-enrollment-index");
    await expect(client.query(rename)).rejects.toMatchObject({
      message: expect.stringContaining("Expected legacy index"),
    });
    await client.query("ROLLBACK");
    await client.query(`
      CREATE TABLE unrelated (id integer PRIMARY KEY);
      CREATE INDEX enrollments_user_id_course_id_unique ON unrelated (id);
    `);
    await expect(client.query(rename)).rejects.toMatchObject({
      message: expect.stringContaining("Expected legacy index"),
    });
    await client.query("ROLLBACK");
    await client.query(`
      DROP INDEX enrollments_user_id_course_id_unique;
      CREATE INDEX enrollments_user_id_course_id_unique ON enrollments (course_id);
      CREATE INDEX enrollments_user_id_course_id_legacy ON unrelated (id);
    `);
    const indexes = async () => (await client.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname
    `)).rows;
    const originalIndexes = await indexes();
    await expect(client.query(rename)).rejects.toMatchObject({
      message: expect.stringContaining("destination name is occupied"),
    });
    await client.query("ROLLBACK");
    expect(await rows(client)).toEqual(originalRows);
    expect(await indexes()).toEqual(originalIndexes);
  });
});

test.each(["migration", "startup repair"] as const)(
  "recovery stays offline when %s cannot merge a referenced duplicate, then safely retries", async (kind) => {
    requireDevelopmentDatabase();
    await withLegacySchema(async (client) => {
      await client.query(`
        ALTER TABLE enrollments ADD CONSTRAINT enrollments_user_id_course_id_unique
          UNIQUE (user_id, course_id, id);
        CREATE TABLE enrollment_references (
          user_id text, course_id integer, enrollment_id integer,
          FOREIGN KEY (user_id, course_id, enrollment_id)
            REFERENCES enrollments (user_id, course_id, id)
        );
        INSERT INTO enrollment_references VALUES ('member', 7, 2);
      `);
      const originalRows = await rows(client);
      await client.query(await operation("rename-incompatible-enrollment-index"));
      await expect(repair(client, kind)).rejects.toMatchObject(kind === "migration"
        ? { code: "23503" } : { cause: { code: "23503" } });
      await client.query("ROLLBACK");
      expect(await rows(client)).toEqual(originalRows);
      expect((await client.query("SELECT * FROM enrollment_references")).rows)
        .toEqual([{ user_id: "member", course_id: 7, enrollment_id: 2 }]);
      const verify = await operation("verify-enrollment-index-recovery");
      await expect(client.query(verify)).rejects.toMatchObject({
        message: expect.stringContaining("Duplicate enrollments remain"),
      });
      await client.query("ROLLBACK");
      expect((await client.query(
        "SELECT to_regclass('enrollments_user_id_course_id_unique') AS index_name",
      )).rows[0].index_name).toBeNull();
      // Simulate separately approved reassignment in this disposable schema only.
      await client.query("UPDATE enrollment_references SET enrollment_id = 1");
      await repair(client, kind);
      await client.query(verify);
      expect(await rows(client)).toEqual([{
        id: 1, completed_lessons: 4, last_lesson_id: 31, enrolled_at: "2022-01-01",
      }]);
    });
  },
);

test("verification refuses an empty table or missing uniqueness instead of reporting success", async () => {
  requireDevelopmentDatabase();
  await withLegacySchema(async (client) => {
    const verify = await operation("verify-enrollment-index-recovery");
    await client.query("DELETE FROM enrollments WHERE id = 2");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("uniqueness is not installed"),
    });
    await client.query("ROLLBACK");
    await repair(client, "migration");
    await client.query("DELETE FROM enrollments");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("No enrollment available"),
    });
    await client.query("ROLLBACK");
    expect(await rows(client)).toEqual([]);
  });
});

test.each(["other constraint", "suppressed insert"] as const)(
  "verification never treats a %s as proof of duplicate rejection", async (behavior) => {
    requireDevelopmentDatabase();
    await withLegacySchema(async (client) => {
      await repair(client, "migration");
      const originalRows = await rows(client);
      await client.query(`
        CREATE FUNCTION interfere_with_probe() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE enrollments SET completed_lessons = 99 WHERE id = 1;
          ${behavior === "other constraint"
            ? "RAISE unique_violation USING CONSTRAINT = 'unrelated_legacy_constraint';"
            : "RETURN NULL;"}
        END
        $$;
        CREATE TRIGGER interfere_with_probe BEFORE INSERT ON enrollments
        FOR EACH ROW EXECUTE FUNCTION interfere_with_probe();
      `);
      await expect(client.query(await operation("verify-enrollment-index-recovery")))
        .rejects.toMatchObject({
          message: expect.stringContaining(behavior === "other constraint"
            ? "unexpected constraint: unrelated_legacy_constraint" : "Duplicate probe was accepted"),
        });
      await client.query("ROLLBACK");
      expect(await rows(client)).toEqual(originalRows);
    });
  },
);