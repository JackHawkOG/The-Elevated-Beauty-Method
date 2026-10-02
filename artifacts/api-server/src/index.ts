import app from "./app";
import { logger } from "./lib/logger";
import { ensureMemberJourneyContent } from "./lib/seed-member-journey";
import { ensureProgressSchema } from "./lib/ensure-progress-schema";
import { ensureEnrollmentSchema } from "./lib/ensure-enrollment-schema";
import { ensurePublicationSchema } from "./lib/ensure-publication-schema";
import { ensureRadiantAuditSchema, startRadiantAuditReceiptCleanup, startRadiantAuditDraftPruning } from "./lib/ensure-radiant-audit-schema";
import { ensureMembershipSchema } from "./lib/ensure-membership-schema";
import { ensureAnnouncementSchema } from "./lib/ensure-announcement-schema";
import { reconcileAnnouncementActivity } from "./lib/reconcile-announcement-activity";
import { reportAfterFirstHealthcheck } from "./routes/health";
import { ensureMemberStoriesSchema } from "./lib/ensure-member-stories-schema";
import { ensureProfileSchema } from "./lib/ensure-profile-schema";
import { getStripeSync, getUncachableStripeClient } from "./lib/stripeClient";
import { syncStripeStartupBackfill } from "./lib/stripe-startup-backfill";
import { startMembershipReconciliation } from "./lib/membership-reconciliation";
import { runMigrations } from "stripe-replit-sync";
import { startCheckoutExpirationRecovery } from "./lib/membership-checkout-expirations";
import { startMembershipOrphanRecovery } from "./lib/membership-orphan-recovery";
import { startUntrackedPaidCheckoutRecovery } from "./lib/membership-paid-recovery";
import { ensureRoutineGuideSchema, startRoutineGuideRateLimitCleanup } from "./lib/ensure-routine-guide-schema";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await ensureProfileSchema();
await ensureEnrollmentSchema();
await ensureAnnouncementSchema();
await ensureMemberStoriesSchema();
await ensureProgressSchema();
await ensureRadiantAuditSchema();
await ensureMembershipSchema();
await ensureRoutineGuideSchema();
const needsPublicationBackfill = await ensurePublicationSchema();
await ensureMemberJourneyContent(needsPublicationBackfill);
const announcementRepair = await reconcileAnnouncementActivity();
// Deployment logs may not index pre-listen output. The configured startup
// health check runs after the server is accepting requests; report the
// committed result once there rather than rerunning a non-repeatable repair.
reportAfterFirstHealthcheck(() => {
  logger.info(announcementRepair, "Legacy announcement activity reconciliation");
  if (announcementRepair.review.length) {
    logger.warn({ review: announcementRepair.review }, "Ambiguous legacy announcement activity requires manual review");
  }
});

if (!process.env.DATABASE_URL || !process.env.REPLIT_DOMAINS?.split(",")[0]) {
  throw new Error("Stripe requires DATABASE_URL and REPLIT_DOMAINS");
}
await runMigrations({ databaseUrl: process.env.DATABASE_URL });
const stripeSync = await getStripeSync();
await stripeSync.findOrCreateManagedWebhook(`https://${process.env.REPLIT_DOMAINS.split(",")[0]}/api/stripe/webhook`);
await syncStripeStartupBackfill(
  stripeSync,
  async id => (await getUncachableStripeClient()).customers.retrieve(id),
  customerId => logger.warn({ customerId }, "Repaired a verified deleted Stripe customer during startup backfill"),
);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startRadiantAuditReceiptCleanup();
  startRadiantAuditDraftPruning();
  startMembershipReconciliation();
  startCheckoutExpirationRecovery();
  startMembershipOrphanRecovery();
  startUntrackedPaidCheckoutRecovery();
  startRoutineGuideRateLimitCleanup();
});
