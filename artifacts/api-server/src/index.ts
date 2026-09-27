import app from "./app";
import { logger } from "./lib/logger";
import { ensureMemberJourneyContent } from "./lib/seed-member-journey";
import { ensureProgressSchema } from "./lib/ensure-progress-schema";
import { ensureEnrollmentSchema } from "./lib/ensure-enrollment-schema";
import { ensurePublicationSchema } from "./lib/ensure-publication-schema";
import { ensureRadiantAuditSchema } from "./lib/ensure-radiant-audit-schema";
import { ensureMembershipSchema } from "./lib/ensure-membership-schema";
import { ensureAnnouncementSchema } from "./lib/ensure-announcement-schema";
import { ensureMemberStoriesSchema } from "./lib/ensure-member-stories-schema";
import { getStripeSync } from "./lib/stripeClient";
import { startMembershipReconciliation } from "./lib/membership-reconciliation";
import { runMigrations } from "stripe-replit-sync";

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

await ensureEnrollmentSchema();
await ensureAnnouncementSchema();
await ensureMemberStoriesSchema();
await ensureProgressSchema();
await ensureRadiantAuditSchema();
await ensureMembershipSchema();
const needsPublicationBackfill = await ensurePublicationSchema();
await ensureMemberJourneyContent(needsPublicationBackfill);

if (!process.env.DATABASE_URL || !process.env.REPLIT_DOMAINS?.split(",")[0]) {
  throw new Error("Stripe requires DATABASE_URL and REPLIT_DOMAINS");
}
await runMigrations({ databaseUrl: process.env.DATABASE_URL });
const stripeSync = await getStripeSync();
await stripeSync.findOrCreateManagedWebhook(`https://${process.env.REPLIT_DOMAINS.split(",")[0]}/api/stripe/webhook`);
await stripeSync.syncBackfill({ object: "all" });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startMembershipReconciliation();
});
