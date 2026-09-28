import type { User } from "@clerk/backend";
import { randomBytes } from "node:crypto";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";

const marker = "community-live-v1";
const emailPattern = /^community-([0-9a-f]{12})\+clerk_test@example\.com$/;
// Before fixture metadata, the browser test used randomUUID().slice(0, 12):
// eight hex digits, a hyphen, then three more hex digits.
const legacyEmailPattern = /^community-(?:[0-9a-f]{8}-[0-9a-f]{3}|[0-9a-f]{12})\+clerk_test@example\.com$/;
const staleAfterMs = 24 * 60 * 60 * 1000;

export const communityFixturePrivateMetadata = { communityLiveFixture: marker };
export const requireCommunityDevelopment = requireAuditDevelopment;

export function newCommunityFixtureTag() {
  return randomBytes(6).toString("hex");
}

export function communityFixtureEmail(tag: string) {
  if (!/^[0-9a-f]{12}$/.test(tag)) throw new Error("Invalid community fixture tag");
  return `community-${tag}+clerk_test@example.com`;
}

export function staleCommunityFixtureTag(
  user: Pick<User, "emailAddresses" | "privateMetadata" | "createdAt" | "firstName" | "lastName">,
  now = Date.now(),
) {
  const email = user.emailAddresses.length === 1 && user.emailAddresses[0].emailAddress;
  const tag = email && emailPattern.exec(email)?.[1];
  return user.privateMetadata.communityLiveFixture === marker &&
    user.firstName === "Community" && user.lastName === "Check" &&
    Number.isFinite(user.createdAt) && user.createdAt <= now - staleAfterMs
    ? tag || undefined : undefined;
}

// A possible legacy identity is not an owned fixture. Never use this predicate
// to authorize deletion: email patterns and age are only leads for human review.
export function possibleLegacyCommunityIdentity(
  user: Pick<User, "emailAddresses" | "privateMetadata" | "createdAt">,
  now = Date.now(),
) {
  return user.privateMetadata.communityLiveFixture === undefined &&
    Number.isFinite(user.createdAt) && user.createdAt <= now - staleAfterMs
    ? user.emailAddresses.find(address => legacyEmailPattern.test(address.emailAddress))?.emailAddress
    : undefined;
}

export function isCommunityFixturePost(
  post: { title: string; body: string; pinned: boolean; requestKey: string | null },
  tag: string,
) {
  return (
    (post.title === `Community retry ${tag}` && post.body === `Message ${tag}`) ||
    ([`Community changed ${tag}`, `Community changed ${tag} edited`].includes(post.title) &&
      post.body === `Original message ${tag}`)
  ) &&
    post.pinned === false && !!post.requestKey &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(post.requestKey);
}

export function isCommunityFixtureActivity(
  activity: { type: string; description: string; actorName: string; entityTitle: string; sourceAnnouncementId: number | null },
  post: { id: number; title: string; authorName: string },
) {
  return activity.type === "announcement" && activity.description === "posted an announcement" &&
    activity.sourceAnnouncementId === post.id && activity.entityTitle === post.title &&
    activity.actorName === post.authorName;
}