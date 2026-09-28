import { requireDevelopmentDatabase } from "./test-development-database";

export const PAID_TOTAL_FIXTURE = "membership-confirmed-counts-browser-v1";
export const MIN_AGE_MS = 60 * 60 * 1000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EMAIL = new RegExp(`^membership-counts-(member|owner|admin)-(${UUID})@example\\.com$`);
const RUN = new RegExp(`^${UUID}$`);

type Identity = {
  emailAddresses: { emailAddress: string }[];
  firstName: string | null;
  lastName: string | null;
  privateMetadata: Record<string, unknown>;
  publicMetadata: Record<string, unknown>;
  createdAt: number;
};

export function requirePaidTotalDevelopment(env: NodeJS.ProcessEnv = process.env): void {
  requireDevelopmentDatabase(env);
  if (!env.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
      !env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      !env.VITE_CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      env.CLERK_PUBLISHABLE_KEY !== env.VITE_CLERK_PUBLISHABLE_KEY) {
    throw new Error("Paid-total cleanup requires matching development Clerk keys");
  }
}

export function fixtureIdentity(user: Identity, now = Date.now()): { run: string; role: string; email: string } | undefined {
  const email = user.emailAddresses[0]?.emailAddress;
  const match = email && EMAIL.exec(email);
  if (!match || user.emailAddresses.length !== 1 ||
      user.firstName !== "Membership Counts Check" || user.lastName !== null ||
      user.privateMetadata.paidTotalCheck !== PAID_TOTAL_FIXTURE ||
      user.publicMetadata.role !== match[1] ||
      !Number.isFinite(user.createdAt) || user.createdAt > now - MIN_AGE_MS) return;
  return { run: match[2], role: match[1], email };
}

// Older runs did not mark Clerk identities. Surface them for human review but
// never treat a matching name and email as proof of ownership for deletion.
export function unmarkedIdentity(user: Identity, now = Date.now()): { run: string; role: string; email: string } | undefined {
  const email = user.emailAddresses[0]?.emailAddress;
  const match = email && EMAIL.exec(email);
  if (!match || user.emailAddresses.length !== 1 ||
      user.firstName !== "Membership Counts Check" || user.lastName !== null ||
      user.privateMetadata.paidTotalCheck === PAID_TOTAL_FIXTURE ||
      !Number.isFinite(user.createdAt) || user.createdAt > now - MIN_AGE_MS) return;
  return { run: match[2], role: match[1], email };
}

export function fixtureMember(member: {
  email: string; displayName: string; membershipTier: string;
  bio: string | null; avatarUrl: string | null; skinType: string | null;
  undertone: string | null; featureNeeds: string[] | null;
  lifeStage: string | null; visibilityGoal: string | null; createdAt: Date;
}, email: string, now = Date.now()): boolean {
  return Number.isFinite(member.createdAt.getTime()) &&
    member.createdAt.getTime() <= now - MIN_AGE_MS &&
    member.email === email && member.displayName === "Membership Counts Check" &&
    member.membershipTier === "Free" && member.bio === null && member.avatarUrl === null &&
    member.skinType === null && member.undertone === null && member.featureNeeds === null &&
    member.lifeStage === null && member.visibilityGoal === null;
}

export function confirmedRun(args: string[]): string | undefined {
  if (!args.length) return;
  if (args.length !== 3 || args[0] !== "--delete" || args[1] !== args[2] || !RUN.test(args[1])) {
    throw new Error("To delete, pass --delete <run-uuid> <same-run-uuid> after inspection");
  }
  return args[1];
}