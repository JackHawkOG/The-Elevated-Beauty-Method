import { describe, expect, it } from "vitest";
import {
  fixtureCheckout, fixtureMember, fixtureRows, membershipStatusFixtureMetadata,
  requireMembershipStatusDevelopment, staleMembershipStatusFixture,
} from "./membership-status-fixtures";

const now = Date.now();
const email = "membership-status-a-abcdef123456+clerk_test@example.com";
const identity = {
  emailAddresses: [{ emailAddress: email }],
  privateMetadata: membershipStatusFixtureMetadata,
  publicMetadata: {},
  firstName: null,
  lastName: null,
  createdAt: now - 25 * 60 * 60 * 1000,
};
const member = {
  email, display_name: "New Learner", membership_tier: "Free",
  bio: null, avatar_url: null, skin_type: null, undertone: null,
  feature_needs: null, life_stage: null, visibility_goal: null,
};
const checkout = {
  kind: "standard", status: "confirmed", stripe_subscription_id: "sub_test",
  stripe_customer_id: null, stripe_session_id: null, failed_months: 0,
  last_failed_invoice: null,
};
const env = {
  CLERK_SECRET_KEY: "sk_test_example", CLERK_PUBLISHABLE_KEY: "pk_test_example",
  REPLIT_DEV_DOMAIN: "workspace.replit.dev", PGHOST: "development.db",
  PGPORT: "5432", PGDATABASE: "development", PGUSER: "dev",
  DATABASE_URL: "postgresql://dev:password@development.db:5432/development?sslmode=require",
};

describe("membership privacy fixture deletion boundaries", () => {
  it("accepts only old, marked, exact-shape Clerk identities", () => {
    expect(staleMembershipStatusFixture(identity, now)).toEqual({ email, role: "a", tag: "abcdef123456" });
    expect(staleMembershipStatusFixture({ ...identity, privateMetadata: {} }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({ ...identity, privateMetadata: {
      ...membershipStatusFixtureMetadata, other: "real-data",
    } }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({ ...identity, createdAt: now - 1000 }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({ ...identity, publicMetadata: { role: "owner" } }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({ ...identity, firstName: "Real" }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({
      ...identity, emailAddresses: [...identity.emailAddresses, { emailAddress: "real@example.com" }],
    }, now)).toBeUndefined();
    expect(staleMembershipStatusFixture({
      ...identity, emailAddresses: [{ emailAddress: email.replace("membership-status", "profile") }],
    }, now)).toBeUndefined();
  });

  it("refuses member changes and unrelated billing rows", () => {
    expect(fixtureMember(member, email)).toBe(true);
    expect(fixtureMember({ ...member, membership_tier: "Elevated" }, email)).toBe(true);
    expect(fixtureMember({ ...member, bio: "Private" }, email)).toBe(false);
    expect(fixtureMember({ ...member, email: "other@example.com" }, email)).toBe(false);
    expect(fixtureCheckout(checkout, "standard", "sub_test")).toBe(true);
    expect(fixtureCheckout({ ...checkout, stripe_customer_id: "cus_other" }, "standard", "sub_test")).toBe(false);
    expect(fixtureCheckout({ ...checkout, status: "pending" }, "standard", "sub_test")).toBe(false);
    expect(fixtureCheckout(checkout, "founding", "sub_test")).toBe(false);
    // Provisioning happens before the live test writes a checkout. A kill at
    // that point must still leave a cleanable, marked fixture.
    expect(fixtureRows([member], [], { email, role: "a" }, "sub_test")).toBe(true);
    expect(fixtureRows([member], [], { email, role: "a" })).toBe(true);
    expect(fixtureRows([member], [checkout], { email, role: "a" }, "sub_test")).toBe(true);
    expect(fixtureRows([member], [checkout], { email, role: "a" })).toBe(false);
    expect(fixtureRows([{ ...member, bio: "Real profile" }], [], { email, role: "a" })).toBe(false);
  });

  it("rejects production and mismatched database targets", () => {
    expect(() => requireMembershipStatusDevelopment(env)).not.toThrow();
    expect(() => requireMembershipStatusDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
    expect(() => requireMembershipStatusDevelopment({ ...env, REPLIT_DEPLOYMENT: "1" })).toThrow();
    expect(() => requireMembershipStatusDevelopment({
      ...env, DATABASE_URL: "postgresql://dev:password@production.db/development",
    })).toThrow();
  });
});