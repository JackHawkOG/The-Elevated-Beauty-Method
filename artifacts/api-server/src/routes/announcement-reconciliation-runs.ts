import { Router } from "express";
import { db, announcementReconciliationRunsTable } from "@workspace/db";
import { desc, lt } from "drizzle-orm";
import { ListAnnouncementReconciliationRunsQueryParams, ListAnnouncementReconciliationRunsResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireStaff } from "./announcement-activity-review";

const router = Router();

// Include denied and failed requests in the no-store policy.
router.get("/announcements/reconciliation-runs", (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
}, requireAuth, requireStaff, async (req, res): Promise<void> => {
  const parsed = ListAnnouncementReconciliationRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid archive cursor" });
    return;
  }
  const rows = await db.select().from(announcementReconciliationRunsTable)
    .where(parsed.data.beforeId === undefined ? undefined : lt(announcementReconciliationRunsTable.id, parsed.data.beforeId))
    .orderBy(desc(announcementReconciliationRunsTable.id)).limit(50);
  res.json(ListAnnouncementReconciliationRunsResponse.parse(rows.map(row => ({
    ...row, recordedAt: row.recordedAt.toISOString(),
  }))));
});

export default router;