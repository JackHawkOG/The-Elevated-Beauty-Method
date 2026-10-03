import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { activityTable, announcementsTable, announcementActivityCorrectionsTable, db } from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  ListAnnouncementActivityReviewResponse,
  AttachAnnouncementActivityParams,
  AttachAnnouncementActivityBody,
  AttachAnnouncementActivityResponse,
  ListAnnouncementActivityCorrectionsResponse,
  CorrectAnnouncementActivityParams,
  CorrectAnnouncementActivityBody,
  CorrectAnnouncementActivityResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { planAnnouncementActivityRepair } from "../lib/reconcile-announcement-activity";

const router = Router();

export async function requireStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
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

async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (user.publicMetadata.role !== "owner") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Could not verify announcement correction owner");
    res.status(503).json({ error: "Unable to verify owner access" });
  }
}

function correctionRecord(row: typeof activityTable.$inferSelect, history: (typeof announcementActivityCorrectionsTable.$inferSelect)[]) {
  const entries = history.map(entry => ({
    id: entry.id,
    fromAnnouncementId: entry.fromAnnouncementId,
    toAnnouncementId: entry.toAnnouncementId,
    previousEvidence: entry.previousEvidence,
    previousReviewedBy: entry.previousReviewedBy,
    previousReviewedAt: entry.previousReviewedAt?.toISOString() ?? null,
    evidence: entry.evidence,
    rationale: entry.rationale,
    correctedBy: entry.correctedBy,
    correctedAt: entry.correctedAt.toISOString(),
  }));
  return {
    activityId: row.id,
    actorName: row.actorName,
    entityTitle: row.entityTitle,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    sourceAnnouncementId: row.sourceAnnouncementId,
    sourceEvidence: row.sourceEvidence,
    sourceReviewedBy: row.sourceReviewedBy,
    sourceReviewedAt: row.sourceReviewedAt?.toISOString() ?? null,
    revision: createHash("sha256").update(JSON.stringify({ row, latest: entries.at(-1)?.id ?? null })).digest("hex"),
    history: entries,
  };
}

async function correctionRows(tx: Pick<typeof db, "select">) {
  const [activities, history, announcements] = await Promise.all([
    tx.select().from(activityTable).where(eq(activityTable.type, "announcement")),
    tx.select().from(announcementActivityCorrectionsTable).orderBy(asc(announcementActivityCorrectionsTable.id)),
    tx.select().from(announcementsTable),
  ]);
  return {
    records: activities.filter(row => row.sourceReviewedBy !== null || history.some(entry => entry.activityId === row.id))
      .map(row => correctionRecord(row, history.filter(entry => entry.activityId === row.id))),
    targets: announcements.filter(row => row.actorId === null && row.requestKey === null).map(row => ({
      id: row.id, title: row.title, body: row.body, authorName: row.authorName,
      createdAt: row.createdAt.toISOString(),
      assignedActivityId: activities.find(activity => activity.sourceAnnouncementId === row.id)?.id ?? null,
    })),
  };
}

async function reviewRows(tx: Pick<typeof db, "select">) {
  const announcements = await tx.select().from(announcementsTable);
  const activities = await tx.select().from(activityTable).where(eq(activityTable.type, "announcement"));
  const corrections = await tx.select({
    activityId: announcementActivityCorrectionsTable.activityId,
    from: announcementActivityCorrectionsTable.fromAnnouncementId,
    to: announcementActivityCorrectionsTable.toAnnouncementId,
  }).from(announcementActivityCorrectionsTable);
  const corrected = new Set(corrections.flatMap(row => [row.from, row.to].filter((id): id is number => id !== null)));
  const correctedActivities = new Set(corrections.map(row => row.activityId));
  const plan = planAnnouncementActivityRepair(announcements, activities, corrected);
  return plan.review.map(item => {
    const announcement = announcements.find(row => row.id === item.announcementId)!;
    // A corrected feed entry may only be reassigned by the owner endpoint,
    // which appends the old review to the audit trail.
    const candidates = item.activityIds.filter(id => !correctedActivities.has(id)).map(id => activities.find(row => row.id === id)!);
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

router.get("/announcements/activity-review/corrections", requireAuth, requireOwner, async (_req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  res.json(ListAnnouncementActivityCorrectionsResponse.parse(await correctionRows(db)));
});

router.post("/announcements/activity-review/corrections/:activityId", requireAuth, requireOwner, async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const params = CorrectAnnouncementActivityParams.safeParse(req.params);
  const parsed = CorrectAnnouncementActivityBody.safeParse(req.body);
  const data = parsed.success ? parsed.data : null;
  const rationale = data?.rationale.trim() ?? "";
  const evidence = data?.evidence?.trim() ?? "";
  if (!params.success || !Number.isSafeInteger(params.data.activityId) || params.data.activityId <= 0 ||
    !data || !/^[a-f0-9]{64}$/.test(data.revision) ||
    !Number.isSafeInteger(data.announcementId ?? 0) || (data.announcementId !== null && data.announcementId <= 0) ||
    rationale.length < 20 || rationale.length > 2000 ||
    (data.announcementId !== null && (!data.independentlyVerified || evidence.length < 20 || evidence.length > 2000))) {
    res.status(400).json({ error: "Provide a correction reason (20–2000 characters); reassignment also needs independent evidence" });
    return;
  }
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(750075)`);
    const [row] = await tx.select().from(activityTable).where(and(eq(activityTable.id, params.data.activityId), eq(activityTable.type, "announcement"))).for("update");
    if (!row) return null;
    const history = await tx.select().from(announcementActivityCorrectionsTable)
      .where(eq(announcementActivityCorrectionsTable.activityId, row.id)).orderBy(asc(announcementActivityCorrectionsTable.id));
    if (row.sourceReviewedBy === null && history.length === 0) return null; // Never correct an automatic link.
    if (correctionRecord(row, history).revision !== data.revision ||
      row.sourceAnnouncementId === data.announcementId || (row.sourceAnnouncementId === null && data.announcementId === null)) return null;
    if (data.announcementId !== null) {
      const [target] = await tx.select().from(announcementsTable).where(eq(announcementsTable.id, data.announcementId));
      if (!target || target.actorId !== null || target.requestKey !== null) return null;
      const [assigned] = await tx.select({ id: activityTable.id }).from(activityTable)
        .where(eq(activityTable.sourceAnnouncementId, data.announcementId));
      if (assigned) return null;
    }
    const now = new Date();
    await tx.insert(announcementActivityCorrectionsTable).values({
      activityId: row.id, fromAnnouncementId: row.sourceAnnouncementId, toAnnouncementId: data.announcementId,
      previousEvidence: row.sourceEvidence, previousReviewedBy: row.sourceReviewedBy, previousReviewedAt: row.sourceReviewedAt,
      evidence: data.announcementId === null ? null : evidence, rationale, correctedBy: req.userId!, correctedAt: now,
    });
    const [updated] = await tx.update(activityTable).set({
      sourceAnnouncementId: data.announcementId,
      sourceEvidence: data.announcementId === null ? null : evidence,
      sourceReviewedBy: data.announcementId === null ? null : req.userId!,
      sourceReviewedAt: data.announcementId === null ? null : now,
    }).where(eq(activityTable.id, row.id)).returning();
    const updatedHistory = await tx.select().from(announcementActivityCorrectionsTable)
      .where(eq(announcementActivityCorrectionsTable.activityId, row.id)).orderBy(asc(announcementActivityCorrectionsTable.id));
    return correctionRecord(updated, updatedHistory);
  });
  if (!result) {
    res.status(409).json({ error: "Link changed, is not manually reviewed, or target is already assigned. Refresh before correcting." });
    return;
  }
  req.log.info({ activityId: result.activityId, from: result.history.at(-1)?.fromAnnouncementId, to: result.sourceAnnouncementId, correctedBy: req.userId }, "Announcement feed assignment corrected");
  res.json(CorrectAnnouncementActivityResponse.parse(result));
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
      sql`NOT EXISTS (SELECT 1 FROM activity other WHERE other.source_announcement_id = ${item.announcementId})`,
      sql`NOT EXISTS (SELECT 1 FROM announcement_activity_corrections correction WHERE correction.activity_id = ${candidate.id})`
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