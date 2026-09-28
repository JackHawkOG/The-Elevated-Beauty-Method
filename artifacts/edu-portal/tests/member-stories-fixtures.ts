import type { User } from "@clerk/backend";
import { randomBytes } from "node:crypto";
import { requireAuditDevelopment } from "./radiant-audit-fixtures";

const marker = "member-stories-live-v1";
const emailPattern = /^story-(owner|member)-([0-9a-f]{12})\+clerk_test@example\.com$/;
const staleAfterMs = 24 * 60 * 60 * 1000;

export const storyFixturePrivateMetadata = { memberStoriesLiveFixture: marker };
export const requireStoryDevelopment = requireAuditDevelopment;

export function newStoryFixtureTag() {
  return randomBytes(6).toString("hex");
}

export function storyFixtureEmail(role: "owner" | "member", tag: string) {
  if (!/^[0-9a-f]{12}$/.test(tag)) throw new Error("Invalid story fixture tag");
  return `story-${role}-${tag}+clerk_test@example.com`;
}

export function staleStoryFixture(
  user: Pick<User, "emailAddresses" | "privateMetadata" | "createdAt" | "firstName" | "lastName" | "publicMetadata">,
  now = Date.now(),
) {
  const email = user.emailAddresses.length === 1 && user.emailAddresses[0].emailAddress;
  const match = email && emailPattern.exec(email);
  if (!match || user.privateMetadata.memberStoriesLiveFixture !== marker ||
      user.firstName !== "Story" || user.lastName !== (match[1] === "owner" ? "Owner" : "Member") ||
      (match[1] === "owner" ? user.publicMetadata.role !== "owner" : user.publicMetadata.role != null) ||
      !Number.isFinite(user.createdAt) || user.createdAt > now - staleAfterMs) return undefined;
  return { role: match[1] as "owner" | "member", tag: match[2] };
}

export function isStoryFixture(
  story: {
    quote: string; attribution: string; permissionRecord: string; permissionRecordedBy: string;
    withdrawnBy: string | null; removalRequestedAt: Date | null;
    removalRequestedBy: string | null; removalRequesterEmail: string | null; removalRequestNote: string | null;
  },
  tag: string,
  ownerId: string,
) {
  return story.quote === `Approved browser check ${tag}` &&
    story.attribution === `Story check ${tag}` &&
    story.permissionRecord === `Disposable test approval for exact quote and attribution ${tag}` &&
    story.permissionRecordedBy === ownerId &&
    (story.withdrawnBy === null || story.withdrawnBy === ownerId) &&
    story.removalRequestedAt === null && story.removalRequestedBy === null &&
    story.removalRequesterEmail === null && story.removalRequestNote === null;
}