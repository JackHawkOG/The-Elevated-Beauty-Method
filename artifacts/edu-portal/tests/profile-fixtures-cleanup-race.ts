import { randomBytes, randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { drizzle } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { expect, vi } from "vitest";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import { profileFixturePrivateMetadata } from "./profile-fixtures";

// Called only by the development integration suite, not by the cleanup CLI.
export async function profileCleanupRace() {
  requireAuditDevelopment();
  const database = await import("../../../lib/db/src/index");
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const run = randomUUID();
  const schema = `profile_race_${randomBytes(12).toString("hex")}`;
  const connection = await database.pool.connect();
  let writer: typeof connection | undefined;
  let schemaCreated = false;
  let ownedId: string | undefined;
  const db = drizzle(connection, { schema: database });

  async function clerkCall<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try { return await operation(); }
      catch (error) {
        if ((error as { status?: number }).status !== 429 || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }

  async function execute(options: {
    beforeDelete?: () => Promise<void>;
    afterCommit?: () => Promise<void>;
    beforeClerkDelete?: () => Promise<void>;
    finalLookup?: () => Promise<void>;
  } = {}) {
    requireAuditDevelopment();
    if (!ownedId) throw new Error("Missing owned race fixture");
    const id = ownedId;
    const errors: unknown[] = [];
    const deleted: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const argv = process.argv;
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(failure => {
      errors.push(failure);
      finish();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let transactions = 0;
    let firstCommitFinished = false;
    // Intercept the awaited RETURNING query, not just the preceding builder.
    // Also pause after the actual first COMMIT, before the final fenced check.
    const cleanupDb = new Proxy(db, {
      get(target, key) {
        if (key !== "transaction") return Reflect.get(target, key);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const number = ++transactions;
          const result = await target.transaction(tx => callback(new Proxy(tx, {
            get(target, key) {
              if (key !== "delete") return Reflect.get(target, key);
              return (...args: Parameters<typeof tx.delete>) => {
                const deletion = target.delete(...args);
                return new Proxy(deletion, {
                  get(target, key) {
                    if (key !== "where") return Reflect.get(target, key);
                    return (condition: SQL | undefined) => {
                      const query = target.where(condition);
                      return new Proxy(query, {
                        get(target, key) {
                          if (key !== "returning") return Reflect.get(target, key);
                          return (...args: Parameters<typeof query.returning>) => {
                            const returning = target.returning(...args);
                            return new Proxy(returning, {
                              get(target, key) {
                                if (key !== "then") return Reflect.get(target, key);
                                return (...args: Parameters<typeof returning.then>) =>
                                  (async () => {
                                    await options.beforeDelete?.();
                                    return await target;
                                  })().then(...args);
                              },
                            });
                          };
                        },
                      });
                    };
                  },
                });
              };
            },
          })));
          if (number === 1) {
            firstCommitFinished = true;
            await options.afterCommit?.();
          }
          return result;
        };
      },
    });
    vi.resetModules();
    vi.doMock("@clerk/backend", () => ({
      createClerkClient: () => ({
        users: {
          getUserList: async ({ limit, offset }: { limit: number; offset: number }) => {
            const page = await clerkCall(() => clerk.users.getUserList({ userId: [id], limit, offset }));
            if (page.data.some(user => user.id !== id)) throw new Error("Clerk race scope escaped");
            return page;
          },
          getUser: async (candidate: string) => {
            if (candidate !== id) throw new Error("Non-owned Clerk lookup");
            if (firstCommitFinished) await options.finalLookup?.();
            return clerkCall(() => clerk.users.getUser(id));
          },
          deleteUser: async (candidate: string) => {
            requireAuditDevelopment();
            if (candidate !== id) throw new Error("Non-owned Clerk deletion");
            const user = await clerkCall(() => clerk.users.getUser(id));
            if (user.privateMetadata.profileCleanupIntegrationRun !== run) throw new Error("Clerk ownership changed");
            await options.beforeClerkDelete?.();
            deleted.push(id);
            return clerkCall(() => clerk.users.deleteUser(id));
          },
        },
      }),
    }));
    vi.doMock("../../../lib/db/src/index", () => ({
      ...database, db: cleanupDb,
      pool: { end: async () => { setTimeout(finish, 0); } },
    }));
    process.argv = ["node", "profile-fixtures-cleanup.ts", "--delete"];
    try {
      await import("./profile-fixtures-cleanup");
      await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Race cleanup did not finish")), 20_000);
        }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 0));
      return { errors, deleted };
    } finally {
      if (timeout) clearTimeout(timeout);
      process.argv = argv;
      process.exitCode = exitCode;
      vi.doUnmock("@clerk/backend");
      vi.doUnmock("../../../lib/db/src/index");
      log.mockRestore();
      error.mockRestore();
      vi.resetModules();
    }
  }

  try {
    writer = await database.pool.connect();
    await connection.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    // No public search-path fallback: an omitted shadow table fails explicitly.
    await connection.query(`SET search_path TO "${schema}"`);
    for (const table of [
      "users", "enrollments", "lesson_completions", "announcements", "member_stories",
      "radiant_audits", "radiant_audit_drafts", "radiant_audit_history", "radiant_audit_submissions",
      "activity", "announcement_activity_corrections", "member_story_review_corrections",
      "membership_checkouts",
    ]) {
      await connection.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING INDEXES)`);
    }
    const tag = randomBytes(6).toString("hex");
    const email = `profile-a-${tag}+clerk_test@example.com`;
    requireAuditDevelopment();
    const user = await clerkCall(() => clerk.users.createUser({
      emailAddress: [email], firstName: "Member A", skipPasswordRequirement: true,
      createdAt: new Date(Date.now() - 28 * 60 * 60 * 1000),
      privateMetadata: { ...profileFixturePrivateMetadata, profileCleanupIntegrationRun: run },
    }));
    ownedId = user.id;
    await connection.query(
      `INSERT INTO "${schema}".users (id, clerk_id, display_name, email, created_at)
       VALUES (1, $1, 'Member A', $2, NOW() - INTERVAL '28 hours')`, [ownedId, email],
    );
    const before = (await connection.query(`SELECT * FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rows[0];
    let writes = 0;
    const result = await execute({ beforeDelete: async () => {
      requireAuditDevelopment();
      const edit = await writer!.query(
        `UPDATE "${schema}".users SET bio = 'Concurrent member edit', skin_type = 'Dry',
         profile_version = $2 WHERE clerk_id = $1 RETURNING *`, [ownedId, randomUUID()],
      );
      expect(edit.rowCount).toBe(1);
      writes++;
    } });
    expect(writes).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors.map(String).join("\n")).toMatch(/member changed during cleanup/);
    expect(result.deleted).toEqual([]);
    const changed = (await connection.query(`SELECT * FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rows;
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ clerk_id: ownedId, bio: "Concurrent member edit", skin_type: "Dry" });
    expect(changed[0].profile_version).not.toBe(before.profile_version);
    expect((await clerkCall(() => clerk.users.getUser(ownedId!))).id).toBe(ownedId);

    // Retrying without erasing the edit must still refuse, preserving all columns.
    const retry = await execute();
    expect(retry.errors.map(String).join("\n")).toMatch(/Non-fixture member row/);
    expect(retry.deleted).toEqual([]);
    expect((await connection.query(`SELECT * FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rows).toEqual(changed);
    expect((await clerkCall(() => clerk.users.getUser(ownedId!))).id).toBe(ownedId);
    // Only an explicit fixture reset authorizes a successful subsequent retry.
    await connection.query(`UPDATE "${schema}".users SET bio = NULL, skin_type = NULL WHERE clerk_id = $1`, [ownedId]);
    const pristine = (await connection.query(`SELECT to_jsonb(u)::text AS snapshot FROM "${schema}".users u WHERE clerk_id = $1`, [ownedId])).rows[0].snapshot;

    // Exercise string identity links without foreign keys as well as private
    // Audit content. Each second connection write actually commits; no sleeps.
    const contentCases = [
      {
        table: "announcements",
        insert: `INSERT INTO "${schema}".announcements (id, title, body, author_name, actor_id)
          VALUES (1, 'Concurrent announcement', 'Keep this content', 'Disposable author', $1)`,
      },
      {
        table: "radiant_audit_drafts",
        insert: `INSERT INTO "${schema}".radiant_audit_drafts (clerk_id, answers, expires_at)
          VALUES ($1, '{"concurrent":"Keep private answers"}', NOW() + INTERVAL '1 day')`,
      },
      {
        table: "member_stories",
        insert: `INSERT INTO "${schema}".member_stories
          (id, quote, attribution, permission_record, permission_recorded_by, permission_recorded_at, published_at)
          VALUES (1, 'Keep this quote', 'Disposable subject', 'Synthetic permission', $1, NOW(), NOW())`,
      },
    ];
    for (const phase of ["beforeDelete", "afterCommit"] as const) {
      for (const content of contentCases) {
        let writes = 0;
        let inserted: unknown[] = [];
        const outcome = await execute({ [phase]: async () => {
          requireAuditDevelopment();
          // The commit hook must see the deletion from another connection.
          expect((await writer!.query(`SELECT id FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rowCount)
            .toBe(phase === "afterCommit" ? 0 : 1);
          await writer!.query(content.insert, [ownedId]);
          inserted = (await writer!.query(`SELECT * FROM "${schema}"."${content.table}"`)).rows;
          writes++;
        } });
        expect(writes, `${phase}: ${content.table}`).toBe(1);
        expect(outcome.errors.map(String).join("\n")).toMatch(/changed after database cleanup/);
        expect(outcome.deleted).toEqual([]);
        expect((await connection.query(`SELECT * FROM "${schema}"."${content.table}"`)).rows).toEqual(inserted);
        expect((await connection.query(`SELECT to_jsonb(u)::text AS snapshot FROM "${schema}".users u WHERE clerk_id = $1`, [ownedId])).rows)
          .toEqual([{ snapshot: pristine }]);
        expect((await clerkCall(() => clerk.users.getUser(ownedId!))).id).toBe(ownedId);
        // A normal retry still refuses until the test explicitly resets content.
        const retry = await execute();
        expect(retry.errors.map(String).join("\n")).toMatch(/Related member data exists/);
        expect(retry.deleted).toEqual([]);
        expect((await connection.query(`SELECT * FROM "${schema}"."${content.table}"`)).rows).toEqual(inserted);
        await connection.query(`DELETE FROM "${schema}"."${content.table}"`);
      }
    }

    const expectRestored = async () => {
      expect((await connection.query(`SELECT to_jsonb(u)::text AS snapshot FROM "${schema}".users u WHERE clerk_id = $1`, [ownedId])).rows)
        .toEqual([{ snapshot: pristine }]);
      expect((await clerkCall(() => clerk.users.getUser(ownedId!))).id).toBe(ownedId);
    };

    // A known content conflict must restore without depending on Clerk. Arm a
    // failing final lookup and prove that cleanup never needs to call it.
    let finalLookups = 0;
    const contentDuringOutage = await execute({
      afterCommit: async () => { await writer!.query(contentCases[0].insert, [ownedId]); },
      finalLookup: async () => {
        finalLookups++;
        throw new Error("Injected final Clerk lookup outage");
      },
    });
    expect(contentDuringOutage.errors.map(String).join("\n")).toMatch(/changed after database cleanup/);
    expect(contentDuringOutage.deleted).toEqual([]);
    expect(finalLookups).toBe(0);
    await expectRestored();
    const outageContent = (await connection.query(`SELECT * FROM "${schema}".announcements`)).rows;
    expect(outageContent).toHaveLength(1);
    expect(outageContent[0]).toMatchObject({ actor_id: ownedId, body: "Keep this content" });
    const contentOutageRetry = await execute();
    expect(contentOutageRetry.errors.map(String).join("\n")).toMatch(/Related member data exists/);
    expect(contentOutageRetry.deleted).toEqual([]);
    expect((await connection.query(`SELECT * FROM "${schema}".announcements`)).rows).toEqual(outageContent);
    await connection.query(`DELETE FROM "${schema}".announcements`);

    // With no known local conflict, a failed final Clerk lookup must still
    // compensate the committed DB deletion, with no external deletion attempt.
    const lookupFailure = await execute({ finalLookup: async () => {
      finalLookups++;
      throw new Error("Injected final Clerk lookup outage");
    } });
    expect(finalLookups).toBe(1);
    expect(lookupFailure.errors.map(String).join("\n")).toMatch(/Injected final Clerk lookup outage/);
    expect(lookupFailure.deleted).toEqual([]);
    await expectRestored();
    const secondLookupFailure = await execute({ finalLookup: async () => {
      throw new Error("Injected final Clerk lookup outage");
    } });
    expect(secondLookupFailure.errors.map(String).join("\n")).toMatch(/Injected final Clerk lookup outage/);
    expect(secondLookupFailure.deleted).toEqual([]);
    await expectRestored();

    // A second connection holds a real table write lock past the CLI's five
    // second fence budget. Compensation must not depend on this linked table.
    let writerTransactionOpen = false;
    try {
      const fenceTimeout = await execute({ afterCommit: async () => {
        expect((await writer!.query(`SELECT id FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rowCount).toBe(0);
        await writer!.query(contentCases[0].insert, [ownedId]);
        await writer!.query("BEGIN");
        writerTransactionOpen = true;
        await writer!.query(`LOCK TABLE "${schema}".announcements IN ROW EXCLUSIVE MODE`);
      } });
      expect(fenceTimeout.errors).toHaveLength(1);
      let failure = fenceTimeout.errors[0];
      while ((failure as { cause?: unknown }).cause) failure = (failure as { cause: unknown }).cause;
      expect(failure).toMatchObject({ code: "55P03" });
      expect(fenceTimeout.deleted).toEqual([]);
      await expectRestored();
      const retained = (await connection.query(`SELECT * FROM "${schema}".announcements`)).rows;
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ actor_id: ownedId, body: "Keep this content" });
      const retry = await execute();
      expect(retry.errors.map(String).join("\n")).toMatch(/Related member data exists/);
      expect(retry.deleted).toEqual([]);
      expect((await connection.query(`SELECT * FROM "${schema}".announcements`)).rows).toEqual(retained);
      await expectRestored();
    } finally {
      if (writerTransactionOpen) await writer!.query("ROLLBACK");
    }
    await connection.query(`DELETE FROM "${schema}".announcements`);

    // A member recreated in the commit gap belongs to the writer, not cleanup.
    let recreated: unknown[] = [];
    const recreation = await execute({ afterCommit: async () => {
      expect((await writer!.query(`SELECT id FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rowCount).toBe(0);
      await writer!.query(`INSERT INTO "${schema}".users
        SELECT * FROM json_populate_record(NULL::"${schema}".users,
          jsonb_set($1::jsonb, '{bio}', '"New member profile in commit gap"')::json)`, [pristine]);
      recreated = (await writer!.query(`SELECT * FROM "${schema}".users`)).rows;
    } });
    expect(recreation.errors.map(String).join("\n")).toMatch(/changed after database cleanup/);
    expect(recreation.deleted).toEqual([]);
    expect((await connection.query(`SELECT * FROM "${schema}".users`)).rows).toEqual(recreated);
    expect((await clerkCall(() => clerk.users.getUser(ownedId!))).id).toBe(ownedId);
    await connection.query(`UPDATE "${schema}".users SET bio = NULL WHERE clerk_id = $1`, [ownedId]);

    // Verify the fence lasts through Clerk deletion: writes on every guarded
    // table must fail with lock_not_available, not slip past a final SELECT.
    let fenced = 0;
    expect(await execute({ beforeClerkDelete: async () => {
      await writer!.query("SET lock_timeout = '100ms'");
      try {
        for (const table of [
          "users", "enrollments", "lesson_completions", "announcements", "member_stories",
          "activity", "announcement_activity_corrections", "member_story_review_corrections",
          "membership_checkouts", "radiant_audit_drafts", "radiant_audits",
          "radiant_audit_history", "radiant_audit_submissions",
        ]) {
          // DELETE also acquires a write lock when no row matches, without
          // introducing an unrelated fixture or relying on column shapes.
          await expect(writer!.query(`DELETE FROM "${schema}"."${table}" WHERE false`))
            .rejects.toMatchObject({ code: "55P03" });
          fenced++;
        }
      } finally {
        await writer!.query("RESET lock_timeout");
      }
    } })).toEqual({ errors: [], deleted: [ownedId] });
    expect(fenced).toBe(13);
    expect((await connection.query(`SELECT * FROM "${schema}".users WHERE clerk_id = $1`, [ownedId])).rowCount).toBe(0);
    // Clerk's list index can briefly retain a deleted identity. Verify the
    // exact identity endpoint instead, allowing bounded deletion propagation.
    await expect.poll(async () => {
      try { await clerkCall(() => clerk.users.getUser(ownedId!)); return false; }
      catch (error) {
        if ((error as { status?: number }).status === 404) return true;
        throw error;
      }
    }, { timeout: 10_000, interval: 1000 }).toBe(true);
  } finally {
    const failures: unknown[] = [];
    if (ownedId) {
      try {
        requireAuditDevelopment();
        let user;
        try { user = await clerkCall(() => clerk.users.getUser(ownedId!)); }
        catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
        }
        if (user) {
          if (user.privateMetadata.profileCleanupIntegrationRun !== run) throw new Error("Refusing non-owned race fixture teardown");
          await clerkCall(() => clerk.users.deleteUser(ownedId!));
        }
      } catch (error) { failures.push(error); }
    }
    if (schemaCreated) {
      try { await connection.query(`DROP SCHEMA "${schema}" CASCADE`); }
      catch (error) { failures.push(error); }
    }
    writer?.release(true);
    connection.release(true);
    if (failures.length) throw new AggregateError(failures, "Profile race fixture teardown failed");
  }
}