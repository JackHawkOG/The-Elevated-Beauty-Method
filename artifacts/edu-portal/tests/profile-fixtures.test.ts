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