import { describe, expect, it } from "vitest";
import {
  possibleUnmarkedProfileFixture, profileFixtureMember, profileFixturePrivateMetadata,
  requireProfileDevelopment, staleProfileFixture, recoverableProfileFixture,
} from "./profile-fixtures";
import { profileCleanupArguments } from "./profile-fixtures-recovery";

const now = Date.now();
const tag = "abcdef123456";
const email = `profile-a-${tag}+clerk_test@example.com`;
const identity = {
  emailAddresses: [{ emailAddress: email }], firstName: "Member A", lastName: null,
  privateMetadata: profileFixturePrivateMetadata, publicMetadata: {},
  createdAt: now - 25 * 60 * 60 * 1000,
};
const member = {
  email, displayName: `Saved A ${tag}`, bio: `Private A ${tag}`,
  avatarUrl: null, membershipTier: "Free", skinType: null, undertone: null,
  featureNeeds: null, lifeStage: null, visibilityGoal: null,
  createdAt: new Date(now - 25 * 60 * 60 * 1000),
};
const env = {
  CLERK_SECRET_KEY: "sk_test_example", CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev", PGHOST: "development.db",
  PGPORT: "5432", PGDATABASE: "development", PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};

describe("profile fixture cleanup boundaries", () => {
  const scenarios = [
    { role: "a", firstName: "Member A", states: [
      { displayName: "Member A", bio: null },
      { displayName: `Saved A ${tag}`, bio: `Private A ${tag}` },
    ] },
    { role: "b", firstName: `Member B ${tag}`, states: [
      { displayName: `Member B ${tag}`, bio: null },
    ] },
    { role: "refresh", firstName: `Profile ${tag}`, states: [
      { displayName: `Profile ${tag}`, bio: null },
      { displayName: `Saved name ${tag}`, bio: `Saved bio ${tag}` },
      { displayName: `New saved name ${tag}`, bio: `New saved bio ${tag}` },
    ] },
    { role: "order", firstName: `Member ${tag}`, states: [
      { displayName: `Member ${tag}`, bio: null },
      { displayName: `Earlier ${tag}`, bio: `Earlier bio ${tag}` },
      { displayName: `Latest ${tag}`, bio: `Latest bio ${tag}` },
    ] },
  ] as const;

  it.each(scenarios)("recognizes only owned, aged $role initial and saved states", scenario => {
    const email = `profile-${scenario.role}-${tag}+clerk_test@example.com`;
    const owned = { ...identity, firstName: scenario.firstName, emailAddresses: [{ emailAddress: email }] };
    const fixture = staleProfileFixture(owned, now)!;
    expect(fixture).toEqual({ role: scenario.role, tag, email });
    for (const state of scenario.states) {
      const saved = { ...member, email, ...state };
      expect(profileFixtureMember(saved, fixture, now)).toBe(true);
      for (const change of [
        { email: "real@example.com" }, { membershipTier: "Elevated" },
        { displayName: "Real member" }, { bio: "Real bio" },
        { avatarUrl: "https://example.com/avatar.png" }, { skinType: "Dry" },
        { undertone: "Warm" }, { featureNeeds: ["Eyes"] },
        { lifeStage: "Adult" }, { visibilityGoal: "Real goal" },
        { createdAt: new Date(now) },
      ]) expect(profileFixtureMember({ ...saved, ...change }, fixture, now)).toBe(false);
    }
    for (const change of [
      { privateMetadata: {} }, { privateMetadata: { profileLiveFixture: "other-suite" } },
      { publicMetadata: { role: "member" } }, { createdAt: now },
      { firstName: "Real member" }, { lastName: "Real surname" },
      { emailAddresses: [...owned.emailAddresses, { emailAddress: "real@example.com" }] },
      { emailAddresses: [{ emailAddress: email.replace(tag, "abcdef12-345") }] },
    ]) expect(staleProfileFixture({ ...owned, ...change }, now)).toBeUndefined();
    // Unmarked email/name matches may be reviewed, but cannot be deleted.
    expect(possibleUnmarkedProfileFixture({ ...owned, privateMetadata: {} }, now)).toEqual(fixture);
  });

  it.each(scenarios)("refuses mixed or cross-scenario saved states for $role", scenario => {
    const email = `profile-${scenario.role}-${tag}+clerk_test@example.com`;
    const fixture = { role: scenario.role, tag, email };
    for (const other of scenarios) for (const name of other.states) for (const bio of other.states) {
      const expected = scenario.states.some(state =>
        state.displayName === name.displayName && state.bio === bio.bio);
      expect(profileFixtureMember({
        ...member, email, displayName: name.displayName, bio: bio.bio,
      }, fixture, now)).toBe(expected);
    }
    expect(profileFixtureMember({
      ...member, email, displayName: `Unsaved name ${tag}`, bio: `Unsaved bio ${tag}`,
    }, fixture, now)).toBe(false);
  });

  it("requires explicit independent run ownership for aged recovery identities", () => {
    const run = "aabbccdd-1234-4321-8123-abcdef123456";
    const owned = { ...identity, privateMetadata: { profileCleanupIntegrationRun: run } };
    expect(recoverableProfileFixture(owned, run, now)).toEqual({ role: "a", tag, email });
    expect(staleProfileFixture(owned, now)).toBeUndefined();
    for (const privateMetadata of [
      {}, { profileCleanupIntegrationRun: "another-run" },
      { profileCleanupIntegrationRun: run, profileLiveFixture: "another-fixture" },
      { profileCleanupIntegrationRun: run, otherOwner: "other-suite" },
    ]) {
      expect(recoverableProfileFixture({ ...owned, privateMetadata }, run, now)).toBeUndefined();
    }
    expect(recoverableProfileFixture(owned, "", now)).toBeUndefined();
    expect(recoverableProfileFixture({ ...owned, createdAt: now }, run, now)).toBeUndefined();
    expect(recoverableProfileFixture({ ...owned, publicMetadata: { role: "member" } }, run, now)).toBeUndefined();
    expect(recoverableProfileFixture({ ...owned, firstName: "Changed" }, run, now)).toBeUndefined();
    expect(recoverableProfileFixture({ ...owned, privateMetadata: {
      ...profileFixturePrivateMetadata, profileCleanupIntegrationRun: run,
    } }, run, now)).toBeDefined();
  });

  it("never enables recovery without a valid run and explicit unique IDs", () => {
    const run = "aabbccdd-1234-4321-8123-abcdef123456";
    expect(profileCleanupArguments([])).toEqual({ deleteRows: false, recovery: undefined });
    expect(profileCleanupArguments(["--delete"])).toEqual({ deleteRows: true, recovery: undefined });
    expect(profileCleanupArguments(["--recover-run", run, "--id", "user_123", "--id", "user_456"])).toEqual({
      deleteRows: false, recovery: { run, ids: ["user_123", "user_456"] },
    });
    for (const args of [
      ["--recover-run", run], ["--id", "user_123"], ["--recover-run", "bad", "--id", "user_123"],
      ["--recover-run", run, "--id"], ["--recover-run", run, "--id", "*"],
      ["--recover-run", run, "--id", "user_123", "--id", "user_123"],
      ["--delete", "--delete"], ["--recover-run", run, "--recover-run", run, "--id", "user_123"],
      ["--recover-run", run, "--id", email],
    ]) expect(() => profileCleanupArguments(args)).toThrow(/Usage/);
  });

  it("requires an old, explicitly marked identity with the exact test shape", () => {
    expect(staleProfileFixture(identity, now)).toEqual({ role: "a", tag, email });
    expect(staleProfileFixture({
      ...identity, firstName: `Member B ${tag}`,
      emailAddresses: [{ emailAddress: `profile-b-${tag}+clerk_test@example.com` }],
    }, now)?.role).toBe("b");
    expect(staleProfileFixture({ ...identity, privateMetadata: {} }, now)).toBeUndefined();
    expect(possibleUnmarkedProfileFixture({ ...identity, privateMetadata: {} }, now)).toEqual({ role: "a", tag, email });
    expect(possibleUnmarkedProfileFixture(identity, now)).toBeUndefined();
    expect(staleProfileFixture({ ...identity, createdAt: now - 1000 }, now)).toBeUndefined();
    expect(staleProfileFixture({ ...identity, emailAddresses: [...identity.emailAddresses, { emailAddress: "real@example.com" }] }, now)).toBeUndefined();
    expect(staleProfileFixture({ ...identity, publicMetadata: { role: "member" } }, now)).toBeUndefined();
    expect(staleProfileFixture({ ...identity, firstName: "Someone Else" }, now)).toBeUndefined();
  });

  it("refuses changed member data, even for a marked identity", () => {
    const fixture = staleProfileFixture(identity, now)!;
    expect(profileFixtureMember(member, fixture, now)).toBe(true);
    expect(profileFixtureMember({ ...member, displayName: "Real member" }, fixture, now)).toBe(false);
    expect(profileFixtureMember({ ...member, membershipTier: "Elevated" }, fixture, now)).toBe(false);
    expect(profileFixtureMember({ ...member, bio: "Real bio" }, fixture, now)).toBe(false);
    expect(profileFixtureMember({ ...member, createdAt: new Date(now - 1000) }, fixture, now)).toBe(false);
    expect(profileFixtureMember({ ...member, email: "real@example.com" }, fixture, now)).toBe(false);
  });

  it("rejects production credentials, deployments and alternate database targets", () => {
    expect(() => requireProfileDevelopment(env)).not.toThrow();
    expect(() => requireProfileDevelopment({ ...env, NODE_ENV: "production" })).toThrow();
    expect(() => requireProfileDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
    expect(() => requireProfileDevelopment({ ...env, DATABASE_URL: "postgresql://dev@production.db/development" })).toThrow();
    expect(() => requireProfileDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&options=-c%20search_path%3Dother` })).toThrow();
  });
});