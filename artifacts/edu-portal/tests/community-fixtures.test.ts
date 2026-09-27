import { describe, expect, it } from "vitest";
import {
  communityFixtureEmail, communityFixturePrivateMetadata, isCommunityFixtureActivity,
  isCommunityFixturePost, newCommunityFixtureTag, requireCommunityDevelopment, staleCommunityFixtureTag,
} from "./community-fixtures";

const env = {
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev",
  PGHOST: "development.db",
  PGPORT: "5432",
  PGDATABASE: "development",
  PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};
const tag = "abcdef123456";
const now = Date.now();
const user = {
  emailAddresses: [{ emailAddress: communityFixtureEmail(tag) }],
  privateMetadata: communityFixturePrivateMetadata,
  firstName: "Community",
  lastName: "Check",
  createdAt: now - 25 * 60 * 60 * 1000,
};

describe("community fixture cleanup boundaries", () => {
  it("recognizes only aged, marked, dedicated test identities", () => {
    const generated = newCommunityFixtureTag();
    expect(generated).toMatch(/^[0-9a-f]{12}$/);
    expect(staleCommunityFixtureTag({
      ...user, emailAddresses: [{ emailAddress: communityFixtureEmail(generated) }],
    }, now)).toBe(generated);
    expect(staleCommunityFixtureTag(user, now)).toBe(tag);
    expect(staleCommunityFixtureTag({ ...user, createdAt: now - 23 * 60 * 60 * 1000 }, now)).toBeUndefined();
    expect(staleCommunityFixtureTag({ ...user, privateMetadata: {} }, now)).toBeUndefined();
    expect(staleCommunityFixtureTag({ ...user, lastName: "Member" }, now)).toBeUndefined();
    expect(staleCommunityFixtureTag({ ...user, emailAddresses: [{ emailAddress: "member@example.com" }] }, now)).toBeUndefined();
    expect(staleCommunityFixtureTag({ ...user, emailAddresses: [...user.emailAddresses, { emailAddress: "other@example.com" }] }, now)).toBeUndefined();
    expect(() => communityFixtureEmail("non-random")).toThrow();
  });

  it("requires development Clerk, preview, and database", () => {
    expect(() => requireCommunityDevelopment(env)).not.toThrow();
    expect(() => requireCommunityDevelopment({ ...env, REPLIT_DEPLOYMENT: "1" })).toThrow();
    expect(() => requireCommunityDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
    expect(() => requireCommunityDevelopment({ ...env, DATABASE_URL: "postgresql://dev@production.db/development" })).toThrow();
    expect(() => requireCommunityDevelopment({ ...env, DATABASE_URL: `${env.DATABASE_URL}&host=production.db` })).toThrow();
  });

  it("rejects other posts and unrelated feed activity even for a marked identity", () => {
    const post = {
      id: 42, title: `Community retry ${tag}`, body: `Message ${tag}`,
      authorName: "Community Check", pinned: false, requestKey: "6b894f97-cd35-4cf2-b90e-65409379f247",
    };
    expect(isCommunityFixturePost(post, tag)).toBe(true);
    expect(isCommunityFixturePost({ ...post, title: "Real announcement" }, tag)).toBe(false);
    expect(isCommunityFixturePost({ ...post, body: "Actual member content" }, tag)).toBe(false);
    expect(isCommunityFixturePost({ ...post, pinned: true }, tag)).toBe(false);
    expect(isCommunityFixturePost({ ...post, requestKey: null }, tag)).toBe(false);
    const activity = {
      type: "announcement", description: "posted an announcement",
      actorName: "Community Check", entityTitle: post.title, sourceAnnouncementId: post.id,
    };
    expect(isCommunityFixtureActivity(activity, post)).toBe(true);
    expect(isCommunityFixtureActivity({ ...activity, sourceAnnouncementId: 43 }, post)).toBe(false);
    expect(isCommunityFixtureActivity({ ...activity, entityTitle: "Real announcement" }, post)).toBe(false);
    expect(isCommunityFixtureActivity({ ...activity, type: "enrollment" }, post)).toBe(false);
  });
});