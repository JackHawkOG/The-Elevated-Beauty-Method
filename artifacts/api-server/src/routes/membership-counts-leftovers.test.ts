import { expect, test } from "vitest";
import {
  confirmedRun, fixtureIdentity, fixtureMember, MIN_AGE_MS,
  PAID_TOTAL_FIXTURE, requirePaidTotalDevelopment, unmarkedIdentity,
} from "./membership-counts-leftovers";

const run = "12345678-1234-1234-1234-123456789abc";
const now = Date.parse("2026-09-28T12:00:00Z");
const identity = {
  emailAddresses: [{ emailAddress: `membership-counts-owner-${run}@example.com` }],
  firstName: "Membership Counts Check", lastName: null,
  privateMetadata: { paidTotalCheck: PAID_TOTAL_FIXTURE },
  publicMetadata: { role: "owner" },
  createdAt: now - MIN_AGE_MS - 1,
};
const member = {
  email: identity.emailAddresses[0].emailAddress, displayName: "Membership Counts Check",
  membershipTier: "Free", bio: null, avatarUrl: null, skinType: null, undertone: null,
  featureNeeds: null, lifeStage: null, visibilityGoal: null,
  createdAt: new Date(now - MIN_AGE_MS - 1),
};

test("only aged explicitly owned identities match", () => {
  expect(fixtureIdentity(identity, now)).toEqual({ run, role: "owner", email: member.email });
  for (const changed of [
    { privateMetadata: {} },
    { publicMetadata: { role: "admin" } },
    { firstName: "Real Person" },
    { lastName: "Example" },
    { emailAddresses: [{ emailAddress: `membership-counts-owner-${run}@example.com` }, { emailAddress: "other@example.com" }] },
    { emailAddresses: [{ emailAddress: `membership-counts-owner-${run}@example.com.fake` }] },
    { createdAt: now - MIN_AGE_MS + 1 },
  ]) expect(fixtureIdentity({ ...identity, ...changed }, now)).toBeUndefined();
});

test("local rows must remain the original free account", () => {
  expect(fixtureMember(member, member.email, now)).toBe(true);
  expect(fixtureMember({ ...member, membershipTier: "Founding" }, member.email, now)).toBe(false);
  expect(fixtureMember({ ...member, bio: "Real member" }, member.email, now)).toBe(false);
  expect(fixtureMember(member, "someone@example.com", now)).toBe(false);
  expect(fixtureMember({ ...member, createdAt: new Date(now) }, member.email, now)).toBe(false);
});

test("older unmarked matches can be inspected but not automatically deleted", () => {
  expect(unmarkedIdentity({ ...identity, privateMetadata: {} }, now))
    .toEqual({ run, role: "owner", email: member.email });
  expect(fixtureIdentity({ ...identity, privateMetadata: {} }, now)).toBeUndefined();
  expect(unmarkedIdentity(identity, now)).toBeUndefined();
});

test("deletion requires a repeated run identifier", () => {
  expect(confirmedRun([])).toBeUndefined();
  expect(confirmedRun(["--delete", run, run])).toBe(run);
  expect(() => confirmedRun(["--delete", run])).toThrow();
  expect(() => confirmedRun(["--delete", run, "other"])).toThrow();
});

test("Clerk and database must both be development targets", () => {
  const env = {
    NODE_ENV: "development", DATABASE_URL: "postgres://me:secret@localhost:5432/dev",
    PGHOST: "localhost", PGPORT: "5432", PGDATABASE: "dev", PGUSER: "me",
    CLERK_SECRET_KEY: "sk_test_example", CLERK_PUBLISHABLE_KEY: "pk_test_example",
    VITE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
  } as NodeJS.ProcessEnv;
  expect(() => requirePaidTotalDevelopment(env)).not.toThrow();
  expect(() => requirePaidTotalDevelopment({ ...env, REPLIT_DEPLOYMENT: "1" })).toThrow();
  expect(() => requirePaidTotalDevelopment({ ...env, CLERK_SECRET_KEY: "sk_live_example" })).toThrow();
  expect(() => requirePaidTotalDevelopment({ ...env, DATABASE_URL: "postgres://me:secret@elsewhere:5432/dev" })).toThrow();
});