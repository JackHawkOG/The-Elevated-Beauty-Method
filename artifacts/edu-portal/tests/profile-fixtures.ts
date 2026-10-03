import type { User } from "@clerk/backend";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";

const marker = "profile-live-v1";
const emailPattern = /^profile-([ab])-([0-9a-f]{12})\+clerk_test@example\.com$/;
const staleAfterMs = 24 * 60 * 60 * 1000;

export const profileFixturePrivateMetadata = { profileLiveFixture: marker };
export const requireProfileDevelopment = requireAuditDevelopment;

function profileShape(
  user: Pick<User, "emailAddresses" | "privateMetadata" | "publicMetadata" | "createdAt" | "firstName" | "lastName">,
  now: number,
): { role: "a" | "b"; tag: string; email: string } | undefined {
  if (user.emailAddresses.length !== 1) return;
  const email = user.emailAddresses[0].emailAddress;
  const match = emailPattern.exec(email);
  if (!match || Object.keys(user.publicMetadata).length !== 0 ||
      user.firstName !== (match[1] === "a" ? "Member A" : `Member B ${match[2]}`) ||
      user.lastName !== null || !Number.isFinite(user.createdAt) ||
      user.createdAt > now - staleAfterMs) return;
  return { role: match[1] as "a" | "b", tag: match[2], email };
}

export function staleProfileFixture(
  user: Parameters<typeof profileShape>[0], now = Date.now(),
) {
  return user.privateMetadata.profileLiveFixture === marker ? profileShape(user, now) : undefined;
}

// A matching legacy email/name is a review hint, never deletion authorization.
export function possibleUnmarkedProfileFixture(
  user: Parameters<typeof profileShape>[0], now = Date.now(),
) {
  return user.privateMetadata.profileLiveFixture === undefined ? profileShape(user, now) : undefined;
}

// Integration-run ownership is independent of the ordinary fixture marker.
// Only an explicit recovery scope may use it, never the normal discovery scan.
export function recoverableProfileFixture(
  user: Parameters<typeof profileShape>[0], run: string, now = Date.now(),
) {
  const metadata = user.privateMetadata;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run) ||
      metadata.profileCleanupIntegrationRun !== run ||
      (metadata.profileLiveFixture !== undefined && metadata.profileLiveFixture !== marker) ||
      Object.keys(metadata).some(key =>
        key !== "profileCleanupIntegrationRun" && key !== "profileLiveFixture")) return;
  return profileShape(user, now);
}

export function profileFixtureMember(
  member: {
    email: string; displayName: string; bio: string | null; avatarUrl: string | null;
    membershipTier: string; skinType: string | null; undertone: string | null;
    featureNeeds: string[] | null; lifeStage: string | null; visibilityGoal: string | null;
    createdAt: Date;
  },
  fixture: { role: "a" | "b"; tag: string; email: string },
  now = Date.now(),
): boolean {
  return member.email === fixture.email && member.membershipTier === "Free" &&
    Number.isFinite(member.createdAt.getTime()) &&
    member.createdAt.getTime() <= now - staleAfterMs &&
    (fixture.role === "a"
      ? ["Member A", `Saved A ${fixture.tag}`].includes(member.displayName) &&
        [null, `Private A ${fixture.tag}`].includes(member.bio)
      : member.displayName === `Member B ${fixture.tag}` && member.bio === null) &&
    member.avatarUrl === null && member.skinType === null && member.undertone === null &&
    member.featureNeeds === null && member.lifeStage === null && member.visibilityGoal === null;
}