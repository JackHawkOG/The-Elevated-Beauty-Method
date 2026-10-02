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
  let writer: Awaited<ReturnType<typeof database.pool.connect>> | undefined;
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

  async function execute(beforeDelete?: () => Promise<void>) {
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
    // Pause at execution of the actual DELETE, after every validation SELECT.
    // The other connection commits its edit before this statement is sent.
    const cleanupDb = new Proxy(db, {
      get(target, key) {
        if (key !== "transaction") return Reflect.get(target, key);
        return (callback: Parameters<typeof db.transaction>[0]) => target.transaction(tx =>
          callback(new Proxy(tx, {
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
                          if (key !== "then") return Reflect.get(target, key);
                          return (...args: Parameters<typeof query.then>) =>
                            (async () => {
                              await beforeDelete?.();
                              return await target;
                            })().then(...args);
                        },
                      });
                    };
                  },
                });
              };
            },
          })),
        );
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
            return clerkCall(() => clerk.users.getUser(id));
          },
          deleteUser: async (candidate: string) => {
            requireAuditDevelopment();
            if (candidate !== id) throw new Error("Non-owned Clerk deletion");
            const user = await clerkCall(() => clerk.users.getUser(id));
            if (user.privateMetadata.profileCleanupIntegrationRun !== run) throw new Error("Clerk ownership changed");
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
    const result = await execute(async () => {
      requireAuditDevelopment();
      const edit = await writer!.query(
        `UPDATE "${schema}".users SET bio = 'Concurrent member edit', skin_type = 'Dry',
         profile_version = $2 WHERE clerk_id = $1 RETURNING *`, [ownedId, randomUUID()],
      );
      expect(edit.rowCount).toBe(1);
      writes++;
    });
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
    expect(await execute()).toEqual({ errors: [], deleted: [ownedId] });
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