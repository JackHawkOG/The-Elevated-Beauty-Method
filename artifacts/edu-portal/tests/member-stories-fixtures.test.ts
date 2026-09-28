import { describe, expect, it } from "vitest";
import {
  isStoryFixture, newStoryFixtureTag, requireStoryDevelopment, staleStoryFixture,
  storyFixtureEmail, storyFixturePrivateMetadata,
} from "./member-stories-fixtures";

const tag = "abcdef123456";
const now = Date.now();
const owner = {
  emailAddresses: [{ emailAddress: storyFixtureEmail("owner", tag) }],
  privateMetadata: storyFixturePrivateMetadata,
  publicMetadata: { role: "owner" },
  firstName: "Story", lastName: "Owner", createdAt: now - 25 * 60 * 60 * 1000,
};
const story = {
  quote: `Approved browser check ${tag}`,
  attribution: `Story check ${tag}`,
  permissionRecord: `Disposable test approval for exact quote and attribution ${tag}`,
  permissionRecordedBy: "owner-id",
  withdrawnBy: null, removalRequestedAt: null, removalRequestedBy: null,
  removalRequesterEmail: null, removalRequestNote: null,
};
const env = {
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev",
  PGHOST: "development.db", PGPORT: "5432", PGDATABASE: "development", PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};

describe("story fixture cleanup boundaries", () => {
  it("only selects aged, explicitly marked and correctly named development identities", () => {
    expect(newStoryFixtureTag()).toMatch(/^[0-9a-f]{12}$/);
    expect(staleStoryFixture(owner, now)).toEqual({ role: "owner", tag });
    expect(staleStoryFixture({
      ...owner, emailAddresses: [{ emailAddress: storyFixtureEmail("member", tag) }],
      lastName: "Member", publicMetadata: {},
    }, now)).toEqual({ role: "member", tag });
    expect(staleStoryFixture({ ...owner, privateMetadata: {} }, now)).toBeUndefined();
    expect(staleStoryFixture({ ...owner, createdAt: now - 23 * 60 * 60 * 1000 }, now)).toBeUndefined();
    expect(staleStoryFixture({ ...owner, emailAddresses: [...owner.emailAddresses, { emailAddress: "someone@example.com" }] }, now)).toBeUndefined();
    expect(staleStoryFixture({ ...owner, emailAddresses: [{ emailAddress: "member@example.com" }] }, now)).toBeUndefined();
    expect(staleStoryFixture({ ...owner, publicMetadata: { role: "member" } }, now)).toBeUndefined();
    expect(staleStoryFixture({ ...owner, lastName: "Member" }, now)).toBeUndefined();
    expect(() => storyFixtureEmail("owner", "bad")).toThrow();
  });

  it("matches only the exact story recorded by that owner, including withdrawn fixtures", () => {
    expect(isStoryFixture(story, tag, "owner-id")).toBe(true);
    expect(isStoryFixture({ ...story, withdrawnBy: "owner-id" }, tag, "owner-id")).toBe(true);
    expect(isStoryFixture(story, tag, "other-owner")).toBe(false);
    expect(isStoryFixture({ ...story, quote: "A real member quote" }, tag, "owner-id")).toBe(false);
    expect(isStoryFixture({ ...story, attribution: "A real member" }, tag, "owner-id")).toBe(false);
    expect(isStoryFixture({ ...story, permissionRecord: "Actual member consent" }, tag, "owner-id")).toBe(false);
    expect(isStoryFixture({ ...story, withdrawnBy: "other-owner" }, tag, "owner-id")).toBe(false);
    expect(isStoryFixture({ ...story, removalRequestedBy: "member-id" }, tag, "owner-id")).toBe(false);
  });

  it("rejects production and database target overrides", () => {
    expect(() => requireStoryDevelopment(env)).not.toThrow();
    expect(() => requireStoryDevelopment({ ...env, REPLIT_DEPLOYMENT: "1" })).toThrow();
    expect(() => requireStoryDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
    expect(() => requireStoryDevelopment({ ...env, DATABASE_URL: "postgresql://dev@production.db/development" })).toThrow();
    expect(() => requireStoryDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&options=-c%20search_path%3Dother` })).toThrow();
  });
});