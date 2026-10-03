import { randomBytes, randomUUID } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it, vi } from "vitest";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";
import { profileFixturePrivateMetadata } from "./profile-fixtures";
import { profileCleanupRace } from "./profile-fixtures-cleanup-race";

it("preserves concurrent profile/content writes across validation and commit, and fences Clerk deletion", profileCleanupRace, 180_000);

const tables = [
  "users", "enrollments", "lesson_completions", "announcements", "member_stories",
  "radiant_audits", "radiant_audit_drafts", "radiant_audit_history", "radiant_audit_submissions",
  "activity", "announcement_activity_corrections", "member_story_review_corrections",
  "membership_checkouts",
] as const;

it("runs profile cleanup against isolated development Clerk users and temporary database tables", async () => {
  // Guard BEFORE importing the DB, creating remote identities, or changing any fixture.
  requireAuditDevelopment();
  const database = await import("../../../lib/db/src/index");
  const connection = await database.pool.connect();
  const db = drizzle(connection, { schema: database });
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  const run = randomUUID();
  const owned = new Set<string>();
  const fixtures = new Map<string, { id: string; email: string; tag: string }>();
  const createdTables: string[] = [];
  const old = new Date(Date.now() - 28 * 60 * 60 * 1000);
  let localId = 0;

  // Development Clerk has a tighter per-endpoint budget than production. Pace
  // fixture-only calls and honor rate limits without treating outages as absence.
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

  async function remoteIds(ids: string[]) {
    if (!ids.length) return [];
    if (ids.some(id => !owned.has(id))) throw new Error("Non-owned Clerk lookup");
    return (await clerkCall(() => clerk.users.getUserList({ userId: ids, limit: 100 }))).data.map(user => user.id).sort();
  }

  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const table of tables) {
      rows[table] = (await connection.query(`SELECT * FROM pg_temp."${table}"`)).rows;
    }
    return { rows, identities: await remoteIds([...owned]) };
  }

  async function execute(ids: string[], deleteRows: boolean, options: {
    afterList?: () => Promise<void>; failDelete?: boolean;
    recoveryRun?: string; afterRecoveryDiscovery?: () => Promise<void>;
  } = {}) {
    requireAuditDevelopment();
    if (ids.some(id => !owned.has(id))) throw new Error("Non-owned cleanup scope");
    const errors: unknown[] = [];
    const deleted: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const argv = process.argv;
    const exitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      if (String(message).startsWith("No stale marked profile fixtures")) finish();
    });
    const error = vi.spyOn(console, "error").mockImplementation((failure: unknown) => {
      errors.push(failure);
      finish();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let recoveryDiscovered = false;
    vi.resetModules();
    vi.doMock("@clerk/backend", () => ({
      createClerkClient: () => ({
        users: {
          getUserList: async ({ limit, offset }: { limit: number; offset: number }) => {
            if (options.recoveryRun) throw new Error("Recovery must never enumerate identities");
            // Real development Clerk calls, narrowed to THIS run. Never enumerate other users.
            const page = await clerkCall(() => clerk.users.getUserList({ userId: ids, limit, offset }));
            if (page.data.some(user => !owned.has(user.id))) throw new Error("Clerk scope escaped");
            await options.afterList?.();
            return page;
          },
          getUser: async (id: string) => {
            if (!owned.has(id) || !ids.includes(id)) throw new Error("Non-owned Clerk lookup");
            const user = await clerkCall(() => clerk.users.getUser(id));
            if (options.recoveryRun && !recoveryDiscovered) {
              recoveryDiscovered = true;
              await options.afterRecoveryDiscovery?.();
            }
            return user;
          },
          deleteUser: async (id: string) => {
            requireAuditDevelopment();
            if (!owned.has(id)) throw new Error("Non-owned Clerk deletion");
            const user = await clerkCall(() => clerk.users.getUser(id));
            if (user.privateMetadata.profileCleanupIntegrationRun !== run) {
              throw new Error("Clerk fixture ownership changed");
            }
            deleted.push(id);
            if (options.failDelete) throw new Error("Injected development Clerk deletion outage");
            return clerkCall(() => clerk.users.deleteUser(id));
          },
        },
      }),
    }));
    vi.doMock("../../../lib/db/src/index", () => ({
      ...database, db,
      // The CLI owns its pool in production use, not this test's borrowed connection.
      pool: { end: async () => { setTimeout(finish, 0); } },
    }));
    process.argv = ["node", "profile-fixtures-cleanup.ts", ...(deleteRows ? ["--delete"] : []),
      ...(options.recoveryRun ? ["--recover-run", options.recoveryRun, ...ids.flatMap(id => ["--id", id])] : [])];
    try {
      await import("./profile-fixtures-cleanup");
      await Promise.race([
        finished,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Cleanup did not finish")), 45_000);
        }),
      ]);
      // main().catch sets the exit code after its asynchronous finally block.
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

  async function refused(ids: string[], message: RegExp, recoveryRun?: string) {
    const outcomes = [];
    for (const deleteRows of [false, true]) {
      const before = await snapshot();
      const result = await execute(ids, deleteRows, { recoveryRun });
      outcomes.push({ deleteRows, before, result, after: await snapshot() });
    }
    for (const outcome of outcomes) {
      expect(outcome.result.errors.map(String).join("\n"),
        `${outcome.deleteRows ? "Delete" : "Dry run"}; actual Clerk deletion calls: ${outcome.result.deleted.length}`).toMatch(message);
      expect(outcome.result.deleted).toEqual([]);
      expect(outcome.after).toEqual(outcome.before);
    }
  }

  try {
    for (const table of tables) {
      // Session-local shadow tables preserve real column types/defaults/indexes.
      // All reads/writes below and in the CLI resolve here, never to shared member rows.
      await connection.query(`CREATE TEMP TABLE "${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING INDEXES)`);
      createdTables.push(table);
    }
    for (const name of ["stale", "unmarked", "young", "changed-clerk", "changed-member", "linked", "bystander"]) {
      requireAuditDevelopment();
      const tag = randomBytes(6).toString("hex");
      const email = `profile-a-${tag}+clerk_test@example.com`;
      const user = await clerkCall(() => clerk.users.createUser({
        emailAddress: [email], firstName: "Member A",
        skipPasswordRequirement: true,
        createdAt: name === "young" ? new Date() : old,
        privateMetadata: {
          ...(name === "unmarked" || name === "bystander" ? {} : profileFixturePrivateMetadata),
          profileCleanupIntegrationRun: run,
        },
      }));
      // Register immediately, before an assertion or DB operation can fail.
      owned.add(user.id);
      fixtures.set(name, { id: user.id, email, tag });
      await connection.query(
        `INSERT INTO pg_temp.users (id, clerk_id, display_name, email, membership_tier, created_at)
         VALUES ($1, $2, 'Member A', $3, 'Free', $4)`,
        [++localId, user.id, email, name === "young" ? new Date() : old],
      );
    }
    const fixture = (name: string) => fixtures.get(name)!;
    const stale = fixture("stale");
    const protectedIds = [fixture("unmarked").id, fixture("young").id, fixture("bystander").id];
    const beforeDryRun = await snapshot();
    expect(await execute([stale.id, ...protectedIds], false)).toEqual({ errors: [], deleted: [] });
    expect(await snapshot()).toEqual(beforeDryRun);

    // Identity changes AFTER discovery must be checked against a fresh real Clerk response.
    const changedClerk = fixture("changed-clerk");
    for (const deleteRows of [false, true]) {
      const result = await execute([changedClerk.id], deleteRows, {
        afterList: async () => { await clerkCall(() => clerk.users.updateUser(changedClerk.id, { firstName: "Changed fixture identity" })); },
      });
      expect(result.errors.map(String).join("\n")).toMatch(/identity changed/);
      expect(result.deleted).toEqual([]);
      expect((await remoteIds([changedClerk.id]))).toEqual([changedClerk.id]);
      expect((await connection.query("SELECT clerk_id FROM pg_temp.users WHERE clerk_id = $1", [changedClerk.id])).rowCount).toBe(1);
      await clerkCall(() => clerk.users.updateUser(changedClerk.id, { firstName: "Member A" }));
    }
    await connection.query("UPDATE pg_temp.users SET bio = 'Edited non-fixture profile' WHERE clerk_id = $1", [fixture("changed-member").id]);
    await refused([fixture("changed-member").id], /Non-fixture member row/);
    await refused([fixture("changed-member").id], /Non-fixture member row/, run);
    await refused([fixture("young").id], /Recovery ownership or aged fixture shape refused/, run);

    // Matching email alone, another run, a conflicting ordinary marker, or
    // another private owner must all refuse both recovery modes without writes.
    const unmarked = fixture("unmarked");
    for (const privateMetadata of [
      { profileCleanupIntegrationRun: null },
      { profileCleanupIntegrationRun: randomUUID() },
      { profileCleanupIntegrationRun: run, profileLiveFixture: "different-owner" },
      { profileCleanupIntegrationRun: run, otherOwner: "other-suite" },
    ]) {
      try {
        await clerkCall(() => clerk.users.updateUser(unmarked.id, { privateMetadata }));
        await refused([unmarked.id], /Recovery ownership or aged fixture shape refused/, run);
      } finally {
        await clerkCall(() => clerk.users.updateUser(unmarked.id, {
          privateMetadata: { profileCleanupIntegrationRun: run },
        }));
      }
    }
    for (const deleteRows of [false, true]) {
      try {
        const result = await execute([unmarked.id], deleteRows, {
          recoveryRun: run,
          afterRecoveryDiscovery: async () => {
            await clerkCall(() => clerk.users.updateUser(unmarked.id, {
              privateMetadata: { profileCleanupIntegrationRun: randomUUID() },
            }));
          },
        });
        expect(result.errors.map(String).join("\n")).toMatch(/identity changed/);
        expect(result.deleted).toEqual([]);
        expect((await connection.query("SELECT id FROM pg_temp.users WHERE clerk_id = $1", [unmarked.id])).rowCount).toBe(1);
      } finally {
        await clerkCall(() => clerk.users.updateUser(unmarked.id, {
          privateMetadata: { profileCleanupIntegrationRun: run },
        }));
      }
    }

    const linked = fixture("linked");
    const bystander = fixture("bystander");
    const story = (field: string) => ({
      table: "member_stories",
      sql: `INSERT INTO pg_temp.member_stories
        (id, quote, attribution, permission_record, permission_recorded_by, permission_recorded_at, published_at${field === "permission_recorded_by" ? "" : `, "${field}"`})
        VALUES (1, 'Isolated content safety fixture', 'Disposable subject', 'Synthetic permission', $1, NOW(), NOW()${field === "permission_recorded_by" ? "" : ", $2"})`,
      values: field === "permission_recorded_by" ? [linked.id] : [bystander.id, linked.id],
    });
    const auditAnswers = [linked.id, [], [], "Test trend", "Test goal", "Test time"];
    const related = [
      { table: "enrollments", sql: "INSERT INTO pg_temp.enrollments (id, user_id, course_id) VALUES (1, $1, 1)", values: [linked.id] },
      { table: "lesson_completions", sql: "INSERT INTO pg_temp.lesson_completions (user_id, lesson_id) VALUES ($1, 1)", values: [linked.id] },
      { table: "announcements", sql: "INSERT INTO pg_temp.announcements (id, title, body, author_name, actor_id) VALUES (1, 'Isolated real-content shape', 'Synthetic content', 'Disposable author', $1)", values: [linked.id] },
      ...["permission_recorded_by", "withdrawn_by", "removal_requested_by", "verified_subject_user_id", "subject_verified_by", "removal_reviewed_by"].map(story),
      { table: "activity", sql: "INSERT INTO pg_temp.activity (id, type, description, actor_name, entity_title, source_reviewed_by) VALUES (1, 'announcement', 'Synthetic review', 'Disposable author', 'Isolated post', $1)", values: [linked.id] },
      ...["previous_reviewed_by", "corrected_by"].map(field => ({
        table: "announcement_activity_corrections",
        sql: `INSERT INTO pg_temp.announcement_activity_corrections (id, activity_id, rationale, corrected_by${field === "corrected_by" ? "" : ", previous_reviewed_by"})
          VALUES (1, 1, 'Synthetic correction', $1${field === "corrected_by" ? "" : ", $2"})`,
        values: field === "corrected_by" ? [linked.id] : [bystander.id, linked.id],
      })),
      { table: "member_story_review_corrections", sql: "INSERT INTO pg_temp.member_story_review_corrections (id, story_id, outcome, note, reviewed_by) VALUES (1, 1, 'verified_subject', 'Synthetic review', $1)", values: [linked.id] },
      { table: "radiant_audits", sql: "INSERT INTO pg_temp.radiant_audits (clerk_id, routine_checks, values_checks, beauty_trend, mastery_goal, research_time) VALUES ($1, $2, $3, $4, $5, $6)", values: auditAnswers },
      { table: "radiant_audit_drafts", sql: "INSERT INTO pg_temp.radiant_audit_drafts (clerk_id, answers, expires_at) VALUES ($1, '{}', NOW() + INTERVAL '1 day')", values: [linked.id] },
      { table: "radiant_audit_history", sql: "INSERT INTO pg_temp.radiant_audit_history (id, clerk_id, routine_checks, values_checks, beauty_trend, mastery_goal, research_time, completed_at) VALUES (1, $1, $2, $3, $4, $5, $6, NOW())", values: auditAnswers },
      { table: "radiant_audit_submissions", sql: "INSERT INTO pg_temp.radiant_audit_submissions (clerk_id, submission_id, answers) VALUES ($1, $2, '{}')", values: [linked.id, randomUUID()] },
      { table: "membership_checkouts", sql: "INSERT INTO pg_temp.membership_checkouts (id, clerk_id, kind, status) VALUES (1, $1, 'founding', 'confirmed')", values: [linked.id] },
    ];
    for (const content of related) {
      await connection.query(content.sql, content.values);
      try {
        await refused([linked.id], /Related member data exists/);
        await refused([linked.id], /Related member data exists/, run);
      } catch (error) {
        throw new Error(`Linked-content guard failed for ${content.table}: ${content.sql}`, { cause: error });
      } finally {
        await connection.query(`DELETE FROM pg_temp."${content.table}"`);
      }
    }

    // A failure inside the real DELETE transaction must roll back the local row
    // and must not reach Clerk. Use a session-local trigger, never a public object.
    await connection.query(`
      CREATE FUNCTION pg_temp.reject_profile_fixture_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Injected profile fixture database deletion failure';
      END;
      $$;
      CREATE TRIGGER reject_profile_fixture_delete
        AFTER DELETE ON pg_temp.users
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_profile_fixture_delete();
    `);
    try {
      const beforeFailure = await snapshot();
      const result = await execute([stale.id, ...protectedIds], true);
      expect(result.errors).toHaveLength(1);
      const messages: string[] = [];
      for (let error = result.errors[0]; error; error = (error as { cause?: unknown }).cause) {
        messages.push(String(error));
      }
      expect(messages.join("\n")).toMatch(/Injected profile fixture database deletion failure/);
      expect(result.deleted).toEqual([]);
      expect(await snapshot()).toEqual(beforeFailure);
    } finally {
      await connection.query("DROP TRIGGER reject_profile_fixture_delete ON pg_temp.users");
      await connection.query("DROP FUNCTION pg_temp.reject_profile_fixture_delete()");
    }

    // Prove DB-first retry behavior using a real marked stale Clerk fixture.
    const failed = await execute([stale.id, ...protectedIds], true, { failDelete: true });
    expect(failed.errors.map(String).join("\n")).toMatch(/Injected development Clerk deletion outage/);
    expect(failed.deleted).toEqual([stale.id]);
    expect((await connection.query("SELECT id FROM pg_temp.users WHERE clerk_id = $1", [stale.id])).rowCount).toBe(0);
    expect(await remoteIds([stale.id, ...protectedIds])).toEqual([stale.id, ...protectedIds].sort());
    expect(await execute([stale.id, ...protectedIds], true)).toEqual({ errors: [], deleted: [stale.id] });
    const afterDelete = await snapshot();
    expect(await execute([stale.id, ...protectedIds], true)).toEqual({ errors: [], deleted: [] });
    expect(await snapshot()).toEqual(afterDelete);
    expect(await remoteIds(protectedIds)).toEqual([...protectedIds].sort());
    expect((await connection.query("SELECT clerk_id FROM pg_temp.users WHERE clerk_id = ANY($1::text[])", [protectedIds])).rowCount).toBe(3);

    // Simulate teardown stopping before it deletes the intentionally unmarked
    // negative fixture. Its independent run marker survives the interruption.
    const beforeRecovery = await snapshot();
    expect(await execute([unmarked.id], false, { recoveryRun: run })).toEqual({ errors: [], deleted: [] });
    expect(await snapshot()).toEqual(beforeRecovery);
    const interrupted = await execute([unmarked.id], true, { recoveryRun: run, failDelete: true });
    expect(interrupted.errors.map(String).join("\n")).toMatch(/Injected development Clerk deletion outage/);
    expect(interrupted.deleted).toEqual([unmarked.id]);
    expect((await connection.query("SELECT id FROM pg_temp.users WHERE clerk_id = $1", [unmarked.id])).rowCount).toBe(0);
    expect(await remoteIds([unmarked.id])).toEqual([unmarked.id]);
    expect(await execute([unmarked.id], true, { recoveryRun: run })).toEqual({ errors: [], deleted: [unmarked.id] });
    const recovered = await snapshot();
    expect(await execute([unmarked.id], true, { recoveryRun: run })).toEqual({ errors: [], deleted: [] });
    expect(await snapshot()).toEqual(recovered);
    expect(await remoteIds([bystander.id])).toEqual([bystander.id]);
  } finally {
    // Each fixture is exact-ID scoped and has an independent run-ownership marker.
    // Attempt EVERY cleanup even if one remote deletion fails.
    const failures: unknown[] = [];
    for (const id of owned) {
      try {
        requireAuditDevelopment();
        let user;
        try { user = await clerkCall(() => clerk.users.getUser(id)); }
        catch (error) {
          if ((error as { status?: number }).status === 404) continue;
          throw error;
        }
        if (user.privateMetadata.profileCleanupIntegrationRun !== run) throw new Error("Refusing non-owned Clerk fixture cleanup");
        await clerkCall(() => clerk.users.deleteUser(id));
      } catch (error) { failures.push(error); }
    }
    for (const table of [...createdTables].reverse()) {
      try { await connection.query(`DROP TABLE pg_temp."${table}"`); }
      catch (error) { failures.push(error); }
    }
    // Destroy the borrowed session even if dropping a TEMP object failed.
    connection.release(true);
    expect(await remoteIds([...owned])).toEqual([]);
    if (failures.length) throw new AggregateError(failures, "Profile integration fixture cleanup failed");
  }
}, 240_000);