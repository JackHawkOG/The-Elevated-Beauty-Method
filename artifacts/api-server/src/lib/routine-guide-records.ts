import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { db, routineGuideClaimsTable, routineGuideDeliveriesTable, routineGuideRateLimitsTable } from "@workspace/db";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class GuideRecordConflict extends Error {}

export function createGuideRecordStore(database: Omit<typeof db, "$client"> = db) {
  async function review(tx: Parameters<Parameters<typeof database.transaction>[0]>[0], email: string) {
    const emailHash = hash(email);
    // Same lock as public reservations, across every guide version.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`routine-guide:email:${emailHash}`}))`);
    const claims = await tx.select().from(routineGuideClaimsTable)
      .where(eq(routineGuideClaimsTable.emailHash, emailHash)).orderBy(asc(routineGuideClaimsTable.requestId));
    const deliveries = await tx.select().from(routineGuideDeliveriesTable)
      .where(eq(routineGuideDeliveriesTable.emailHash, emailHash)).orderBy(asc(routineGuideDeliveriesTable.guideVersion))
      .for("update");
    const counters = await tx.select().from(routineGuideRateLimitsTable)
      .where(eq(routineGuideRateLimitsTable.keyHash, `email:${emailHash}`))
      .orderBy(asc(routineGuideRateLimitsTable.windowStartedAt));
    return {
      email, claims: claims.length, deliveries: deliveries.length, emailCounters: counters.length,
      activeDelivery: deliveries.some(row =>
        (row.state === "processing" || row.state === "uncertain") &&
        row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now()),
      revision: hash(JSON.stringify({ email, claims, deliveries, counters })),
    };
  }
  return {
    lookup(email: string) {
      return database.transaction(tx => review(tx, email));
    },
    remove(email: string, revision: string) {
      return database.transaction(async tx => {
        const current = await review(tx, email);
        if (current.revision !== revision || current.activeDelivery) {
          throw new GuideRecordConflict("Records changed or delivery is active. Look up the address again before removing.");
        }
        const emailHash = hash(email);
        await tx.delete(routineGuideClaimsTable).where(eq(routineGuideClaimsTable.emailHash, emailHash));
        await tx.delete(routineGuideDeliveriesTable).where(eq(routineGuideDeliveriesTable.emailHash, emailHash));
        await tx.delete(routineGuideRateLimitsTable).where(eq(routineGuideRateLimitsTable.keyHash, `email:${emailHash}`));
        // No external calls, resend, account cleanup, or shared IP-counter deletion.
        return { email, erased: true };
      });
    },
  };
}
export type GuideRecordStore = ReturnType<typeof createGuideRecordStore>;