import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { activityTable, announcementsTable, db } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  ListAnnouncementActivityReviewResponse,
  AttachAnnouncementActivityParams,
  AttachAnnouncementActivityBody,
  AttachAnnouncementActivityResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { planAnnouncementActivityRepair } from "../lib/reconcile-announcement-activity";

const router = Router();

async function requireStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (user.publicMetadata.role !== "owner" && user.publicMetadata.role !== "admin") {
      res.status(403).json({ error: "Staff access required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Could not verify announcement reviewer");
    res.status(503).json({ error: "Unable to verify staff access" });
  }
}

async function reviewRows(tx: Pick<typeof db, "select">) {
  const announcements = await tx.select().from(announcementsTable);
  const activities = await tx.select().from(activityTable).where(eq(activityTable.type, "announcement"));
  const plan = planAnnouncementActivityRepair(announcements, activities);
  return plan.review.map(item => {
    const announcement = announcements.find(row => row.id === item.announcementId)!;
    const candidates = item.activityIds.map(id => activities.find(row => row.id === id)!);
    const revision = createHash("sha256").update(JSON.stringify({
      announcement, candidates,
    })).digest("hex");
    return {
      announcementId: announcement.id,
      title: announcement.title,
      body: announcement.body,
      authorName: announcement.authorName,
      createdAt: announcement.createdAt.toISOString(),
      reason: item.reason,
      revision,
      candidates: candidates.map(row => ({
        id: row.id,
        actorName: row.actorName,
        entityTitle: row.entityTitle,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        sourceAnnouncementId: row.sourceAnnouncementId,
      })),
    };
  });
}

router.get("/announcements/activity-review", requireAuth, requireStaff, async (_req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  res.json(ListAnnouncementActivityReviewResponse.parse(await reviewRows(db)));
});

router.post("/announcements/:announcementId/activity-review", requireAuth, requireStaff, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const params = AttachAnnouncementActivityParams.safeParse(req.params);
  const parsed = AttachAnnouncementActivityBody.safeParse(req.body);
  const evidence = parsed.success ? parsed.data.evidence.trim() : "";
  if (!params.success || !Number.isSafeInteger(params.data.announcementId) || params.data.announcementId <= 0 ||
    !parsed.success || !Number.isSafeInteger(parsed.data.activityId) || parsed.data.activityId <= 0 ||
    !/^[a-f0-9]{64}$/.test(parsed.data.revision) ||
    !parsed.data.independentlyVerified || evidence.length < 20 || evidence.length > 2000) {
    res.status(400).json({ error: "Select a candidate and record independent evidence (20–2000 characters)" });
    return;
  }
  const result = await db.transaction(async tx => {
    // Same lock as startup repair. A stale review or a second reviewer cannot
    // consume an activity while another repair/link is in progress.
    await tx.execute(sql`select pg_advisory_xact_lock(750075)`);
    const queue = await reviewRows(tx);
    const item = queue.find(row => row.announcementId === params.data.announcementId);
    const candidate = item?.candidates.find(row => row.id === parsed.data.activityId);
    if (!item || item.revision !== parsed.data.revision || !candidate || candidate.sourceAnnouncementId !== null) return null;
    const now = new Date();
    const [linked] = await tx.update(activityTable).set({
      sourceAnnouncementId: item.announcementId,
      sourceEvidence: evidence,
      sourceReviewedBy: req.userId!,
      sourceReviewedAt: now,
    }).where(and(eq(activityTable.id, candidate.id), eq(activityTable.type, "announcement"),
      isNull(activityTable.sourceAnnouncementId),
      sql`NOT EXISTS (SELECT 1 FROM activity other WHERE other.source_announcement_id = ${item.announcementId})`
    )).returning({ id: activityTable.id });
    return linked ? { announcementId: item.announcementId, activityId: linked.id, reviewedAt: now.toISOString() } : null;
  });
  if (!result) {
    res.status(409).json({ error: "Review changed or feed entry already assigned. Reload and review again." });
    return;
  }
  req.log.info({ announcementId: result.announcementId, activityId: result.activityId, reviewer: req.userId }, "Legacy announcement activity linked after staff review");
  res.json(AttachAnnouncementActivityResponse.parse(result));
});

export default router;