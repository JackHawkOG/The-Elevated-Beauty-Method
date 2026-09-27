import app from "./app";
import { logger } from "./lib/logger";
import { ensureMemberJourneyContent } from "./lib/seed-member-journey";
import { ensureProgressSchema } from "./lib/ensure-progress-schema";
import { ensurePublicationSchema } from "./lib/ensure-publication-schema";

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

await ensureProgressSchema();
const needsPublicationBackfill = await ensurePublicationSchema();
await ensureMemberJourneyContent(needsPublicationBackfill);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
