import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  db,
  routineGuideClaimsTable,
  routineGuideDeliveriesTable,
  routineGuideRateLimitsTable,
} from "@workspace/db";

export const ROUTINE_GUIDE_VERSION = "1";
export const ROUTINE_GUIDE_CONSENT =
  "Email me The Elevated Routine from The Elevated Beauty Method ™.";
export const ROUTINE_GUIDE_TITLE = "The Elevated Routine";
export const ROUTINE_GUIDE_PRIVACY_NOTICE =
  "Your email is used only to deliver this guide and keep records of consent and delivery retries. Hashed email/IP abuse-prevention counters are also used to limit repeated requests. Resend processes the email to send it. We will not add you to marketing or a mailing list. Email hello@elevatedbeautymethod.com to request removal of these records.";
export const ROUTINE_GUIDE_PAGE_COUNT = 9;
export const ROUTINE_GUIDE_RESPONSE_MESSAGE =
  "The Elevated Routine was accepted for email delivery. Provider acceptance does not confirm inbox delivery.";
export const ROUTINE_GUIDE_PROCESSING_MESSAGE =
  "Your guide request is being processed. Please wait before trying again.";

const ACTIVE_CLAIM_LEASE_MS = 90_000;
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = 72 * 60 * 60 * 1000;
const ADDRESS_LIMIT = 5;
const IP_LIMIT = 20;

type DeliveryRow = typeof routineGuideDeliveriesTable.$inferSelect;

export type Reservation =
  | { kind: "send"; providerIdempotencyKey: string }
  | { kind: "sent" }
  | { kind: "processing" }
  | { kind: "conflict" }
  | { kind: "rate_limited" }
  | { kind: "ambiguous_expired" };

export interface GuideClaimStore {
  reserve(input: {
    requestId: string;
    email: string;
    ip: string;
    now?: Date;
  }): Promise<Reservation>;
  markAccepted(email: string, providerIdempotencyKey: string, now?: Date): Promise<void>;
  markRejected(email: string, providerIdempotencyKey: string, now?: Date): Promise<void>;
  markUncertain(email: string, providerIdempotencyKey: string, now?: Date): Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lockKey(value: string): string {
  return `routine-guide:${value}`;
}

export function getRoutineGuideDeliveryAction(
  delivery: Pick<DeliveryRow, "state" | "leaseUntil" | "firstAttemptAt">,
  now: Date,
): "sent" | "processing" | "retry" | "ambiguous_expired" {
  if (delivery.state === "sent") return "sent";
  if ((delivery.state === "processing" || delivery.state === "uncertain") &&
      delivery.leaseUntil && delivery.leaseUntil > now) return "processing";
  if (now.getTime() - delivery.firstAttemptAt.getTime() >= RESEND_IDEMPOTENCY_WINDOW_MS) {
    return "ambiguous_expired";
  }
  return "retry";
}

// Database injection lets integration checks use the real locking/query path
// without exposing existing delivery records or global rate-limit cleanup.
export const createRoutineGuideClaimStore = (
  database: Omit<typeof db, "$client"> = db,
): GuideClaimStore => ({
  async reserve({ requestId, email, ip, now = new Date() }): Promise<Reservation> {
    const emailHash = sha256(email);
    const ipHash = sha256(ip);
    const windowStartedAt = new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
    const deliveryKey = { guideVersion: ROUTINE_GUIDE_VERSION, emailHash };

    return database.transaction(async (tx): Promise<Reservation> => {
      const lockKeys = [
        lockKey(`request:${requestId}`),
        lockKey(`email:${emailHash}`),
        lockKey(`ip:${ipHash}:${windowStartedAt.toISOString()}`),
      ].sort();
      for (const key of lockKeys) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
      }

      const [existingRequest] = await tx.select().from(routineGuideClaimsTable)
        .where(eq(routineGuideClaimsTable.requestId, requestId)).limit(1);
      if (existingRequest &&
          (existingRequest.emailHash !== emailHash || existingRequest.guideVersion !== ROUTINE_GUIDE_VERSION)) {
        return { kind: "conflict" };
      }

      const [delivery] = await tx.select().from(routineGuideDeliveriesTable)
        .where(and(
          eq(routineGuideDeliveriesTable.guideVersion, ROUTINE_GUIDE_VERSION),
          eq(routineGuideDeliveriesTable.emailHash, emailHash),
        )).limit(1);
      if (existingRequest && delivery) {
        const existingAction = getRoutineGuideDeliveryAction(delivery, now);
        if (existingAction === "sent") return { kind: "sent" };
        if (existingAction === "processing") return { kind: "processing" };
        if (existingAction === "ambiguous_expired") return { kind: "ambiguous_expired" };
      }

      // Count new requests and explicit retries that could initiate a send.
      // Replays of already accepted or actively claimed work return above.
      {
        const [addressCounter] = await tx.insert(routineGuideRateLimitsTable)
          .values({ keyHash: `email:${emailHash}`, windowStartedAt, attempts: 1 })
          .onConflictDoUpdate({
            target: [routineGuideRateLimitsTable.keyHash, routineGuideRateLimitsTable.windowStartedAt],
            set: { attempts: sql`${routineGuideRateLimitsTable.attempts} + 1` },
          })
          .returning({ attempts: routineGuideRateLimitsTable.attempts });
        const [ipCounter] = await tx.insert(routineGuideRateLimitsTable)
          .values({ keyHash: `ip:${ipHash}`, windowStartedAt, attempts: 1 })
          .onConflictDoUpdate({
            target: [routineGuideRateLimitsTable.keyHash, routineGuideRateLimitsTable.windowStartedAt],
            set: { attempts: sql`${routineGuideRateLimitsTable.attempts} + 1` },
          })
          .returning({ attempts: routineGuideRateLimitsTable.attempts });
        if ((addressCounter?.attempts ?? ADDRESS_LIMIT + 1) > ADDRESS_LIMIT ||
            (ipCounter?.attempts ?? IP_LIMIT + 1) > IP_LIMIT) {
          return { kind: "rate_limited" };
        }
      }

      if (!existingRequest) {
        await tx.insert(routineGuideClaimsTable).values({
          requestId,
          emailHash,
          consent: true,
          consentText: ROUTINE_GUIDE_CONSENT,
          guideVersion: ROUTINE_GUIDE_VERSION,
          consentedAt: now,
          createdAt: now,
        });
      }

      await tx.delete(routineGuideRateLimitsTable)
        .where(lt(routineGuideRateLimitsTable.windowStartedAt, new Date(now.getTime() - RATE_LIMIT_RETENTION_MS)));

      if (!delivery) {
        const providerIdempotencyKey = randomUUID();
        await tx.insert(routineGuideDeliveriesTable).values({
          ...deliveryKey,
          email,
          state: "processing",
          providerIdempotencyKey,
          firstAttemptAt: now,
          leaseUntil: new Date(now.getTime() + ACTIVE_CLAIM_LEASE_MS),
          attemptCount: 1,
          updatedAt: now,
        });
        return { kind: "send", providerIdempotencyKey };
      }

      const action = getRoutineGuideDeliveryAction(delivery, now);
      if (action === "sent") return { kind: "sent" };
      if (action === "processing") return { kind: "processing" };
      if (action === "ambiguous_expired") return { kind: "ambiguous_expired" };

      await tx.update(routineGuideDeliveriesTable)
        .set({
          state: "processing",
          leaseUntil: new Date(now.getTime() + ACTIVE_CLAIM_LEASE_MS),
          attemptCount: delivery.attemptCount + 1,
          updatedAt: now,
        })
        .where(and(
          eq(routineGuideDeliveriesTable.guideVersion, ROUTINE_GUIDE_VERSION),
          eq(routineGuideDeliveriesTable.emailHash, emailHash),
        ));
      return { kind: "send", providerIdempotencyKey: delivery.providerIdempotencyKey };
    });
  },

  async markAccepted(email, providerIdempotencyKey, now = new Date()): Promise<void> {
    const [updated] = await database.update(routineGuideDeliveriesTable)
      .set({ state: "sent", acceptedAt: now, leaseUntil: null, updatedAt: now })
      .where(and(
        eq(routineGuideDeliveriesTable.emailHash, sha256(email)),
        eq(routineGuideDeliveriesTable.providerIdempotencyKey, providerIdempotencyKey),
      ))
      .returning({ emailHash: routineGuideDeliveriesTable.emailHash });
    if (!updated) throw new Error("Routine guide acceptance state was not recorded");
  },

  async markRejected(email, providerIdempotencyKey, now = new Date()): Promise<void> {
    const [updated] = await database.update(routineGuideDeliveriesTable)
      .set({ state: "failed", leaseUntil: null, updatedAt: now })
      .where(and(
        eq(routineGuideDeliveriesTable.emailHash, sha256(email)),
        eq(routineGuideDeliveriesTable.providerIdempotencyKey, providerIdempotencyKey),
      ))
      .returning({ emailHash: routineGuideDeliveriesTable.emailHash });
    if (!updated) throw new Error("Routine guide rejection state was not recorded");
  },

  async markUncertain(email, providerIdempotencyKey, now = new Date()): Promise<void> {
    const [updated] = await database.update(routineGuideDeliveriesTable)
      .set({
        state: "uncertain",
        leaseUntil: new Date(now.getTime() + ACTIVE_CLAIM_LEASE_MS),
        updatedAt: now,
      })
      .where(and(
        eq(routineGuideDeliveriesTable.emailHash, sha256(email)),
        eq(routineGuideDeliveriesTable.providerIdempotencyKey, providerIdempotencyKey),
      ))
      .returning({ emailHash: routineGuideDeliveriesTable.emailHash });
    if (!updated) throw new Error("Routine guide uncertainty state was not recorded");
  },
});

export const routineGuideClaimStore = createRoutineGuideClaimStore();