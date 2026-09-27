import app from "./app";
import { logger } from "./lib/logger";
import { ensureMemberJourneyContent } from "./lib/seed-member-journey";
import { ensureProgressSchema } from "./lib/ensure-progress-schema";
import { ensureEnrollmentSchema } from "./lib/ensure-enrollment-schema";
import { ensurePublicationSchema } from "./lib/ensure-publication-schema";
import { ensureRadiantAuditSchema } from "./lib/ensure-radiant-audit-schema";

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
await ensureProgressSchema();
await ensureRadiantAuditSchema();
const needsPublicationBackfill = await ensurePublicationSchema();
await ensureMemberJourneyContent(needsPublicationBackfill);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
