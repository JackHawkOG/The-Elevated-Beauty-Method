import { requireAuditDevelopment } from "./radiant-audit-fixtures";

export const membershipStatusFixtureMetadata = { membershipStatusLiveFixture: "v1" };
export const requireMembershipStatusDevelopment = requireAuditDevelopment;
const emailPattern = /^membership-status-([ab])-([0-9a-f]{12})\+clerk_test@example\.com$/;
const staleMs = 24 * 60 * 60 * 1000;

export function staleMembershipStatusFixture(
  user: {
    emailAddresses: Array<{ emailAddress: string }>;
    privateMetadata: Record<string, unknown>;
    publicMetadata: Record<string, unknown>;
    createdAt: number;
    firstName: string | null;
    lastName: string | null;
  },
  now = Date.now(),
) {
  if (user.privateMetadata.membershipStatusLiveFixture !== membershipStatusFixtureMetadata.membershipStatusLiveFixture ||
      Object.keys(user.privateMetadata).length !== 1 ||
      user.emailAddresses.length !== 1 || Object.keys(user.publicMetadata).length ||
      user.firstName !== null || user.lastName !== null ||
      !Number.isFinite(user.createdAt) || user.createdAt > now - staleMs) return;
  const email = user.emailAddresses[0].emailAddress;
  const match = emailPattern.exec(email);
  return match ? { email, role: match[1] as "a" | "b", tag: match[2] } : undefined;
}

export function fixtureMember(
  member: {
    email: string; display_name: string; membership_tier: string; bio: string | null;
    avatar_url: string | null; skin_type: string | null; undertone: string | null;
    feature_needs: string[] | null; life_stage: string | null; visibility_goal: string | null;
  },
  email: string,
) {
  return member.email === email && member.display_name === "New Learner" &&
    ["Free", "Elevated"].includes(member.membership_tier) && member.bio === null &&
    member.avatar_url === null && member.skin_type === null && member.undertone === null &&
    member.feature_needs === null && member.life_stage === null && member.visibility_goal === null;
}

export function fixtureCheckout(
  row: {
    kind: string; status: string; stripe_subscription_id: string | null;
    stripe_customer_id: string | null; stripe_session_id: string | null;
    failed_months: number; last_failed_invoice: string | null;
  },
  kind: string, subscriptionId: string,
) {
  return row.kind === kind && row.status === "confirmed" &&
    row.stripe_subscription_id === subscriptionId && row.stripe_customer_id === null &&
    row.stripe_session_id === null && row.failed_months === 0 && row.last_failed_invoice === null;
}

export function fixtureRows(
  members: Array<Parameters<typeof fixtureMember>[0]>,
  checkouts: Array<Parameters<typeof fixtureCheckout>[0]>,
  fixture: { email: string; role: "a" | "b" },
  subscriptionId?: string,
) {
  // The signed-in route can provision a member before the test inserts a checkout.
  // A marked fixture with no checkout is a legitimate interrupted state.
  return members.length <= 1 && members.every(row => fixtureMember(row, fixture.email)) &&
    checkouts.length <= 1 && checkouts.every(row =>
      !!subscriptionId && fixtureCheckout(
        row, fixture.role === "a" ? "standard" : "founding", subscriptionId,
      ));
}