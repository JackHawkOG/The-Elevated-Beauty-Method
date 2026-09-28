import { Router, type Request, type Response, type NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, memberStoriesTable, memberStoryReviewCorrectionsTable } from "@workspace/db";
import {
  ListPublishedMemberStoriesResponse,
  ListManagedMemberStoriesResponse,
  ListMemberStoryRemovalAlertsResponse,
  PublishMemberStoryBody,
  PublishMemberStoryResponse,
  WithdrawMemberStoryResponse,
  RequestMemberStoryRemovalBody,
  RequestMemberStoryRemovalResponse,
  ReviewMemberStoryRemovalBody,
  ReviewMemberStoryRemovalResponse,
  CorrectMemberStoryRemovalReviewBody,
  CorrectMemberStoryRemovalReviewResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";

const router = Router();

async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    if (user.publicMetadata.role !== "owner" && user.publicMetadata.role !== "admin") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Could not verify story owner");
    res.status(503).json({ error: "Unable to verify owner access" });
  }
}

type Correction = typeof memberStoryReviewCorrectionsTable.$inferSelect;

function ownerStory(row: typeof memberStoriesTable.$inferSelect, corrections: Correction[] = []) {
  return {
    ...row,
    permissionRecordedAt: row.permissionRecordedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    removalRequestedAt: row.removalRequestedAt?.toISOString() ?? null,
    removalReviewedAt: row.removalReviewedAt?.toISOString() ?? null,
    reviewHistory: [
      ...(row.removalReviewOutcome && row.removalReviewNote && row.removalReviewedAt && row.removalReviewedBy
        ? [{ id: 0, outcome: row.removalReviewOutcome, note: row.removalReviewNote,
          reviewedAt: row.removalReviewedAt.toISOString(), reviewedBy: row.removalReviewedBy }]
        : []),
      ...corrections.map(item => ({
        id: item.id, outcome: item.outcome, note: item.note,
        reviewedAt: item.reviewedAt.toISOString(), reviewedBy: item.reviewedBy,
      })),
    ],
  };
}

router.get("/member-stories", async (_req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const rows = await db.select({
    id: memberStoriesTable.id,
    quote: memberStoriesTable.quote,
    attribution: memberStoriesTable.attribution,
  }).from(memberStoriesTable)
    .where(isNull(memberStoriesTable.withdrawnAt))
    .orderBy(desc(memberStoriesTable.publishedAt));
  res.json(ListPublishedMemberStoriesResponse.parse(rows));
});

router.get("/member-stories/manage", requireAuth, requireOwner, async (_req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const rows = await db.select().from(memberStoriesTable).orderBy(desc(memberStoriesTable.publishedAt));
  const corrections = rows.length ? await db.select().from(memberStoryReviewCorrectionsTable)
    .where(inArray(memberStoryReviewCorrectionsTable.storyId, rows.map(row => row.id)))
    .orderBy(asc(memberStoryReviewCorrectionsTable.id)) : [];
  const byStory = new Map<number, Correction[]>();
  for (const item of corrections) {
    const history = byStory.get(item.storyId) ?? [];
    history.push(item);
    byStory.set(item.storyId, history);
  }
  res.json(ListManagedMemberStoriesResponse.parse(rows.map(row => ownerStory(row, byStory.get(row.id)))));
});

router.get("/member-stories/removal-alerts", requireAuth, requireOwner, async (_req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  const rows = await db.select({
    storyId: memberStoriesTable.id,
    requestedAt: memberStoriesTable.removalRequestedAt,
  }).from(memberStoriesTable)
    .where(and(
      sql`${memberStoriesTable.removalRequestedAt} IS NOT NULL`,
      isNull(memberStoriesTable.removalReviewedAt),
      isNull(memberStoriesTable.removalReviewOutcome),
    ))
    .orderBy(desc(memberStoriesTable.removalRequestedAt));
  res.json(ListMemberStoryRemovalAlertsResponse.parse(rows.map(row => ({
    storyId: row.storyId,
    requestedAt: row.requestedAt!.toISOString(),
  }))));
});

router.post("/member-stories", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const parsed = PublishMemberStoryBody.safeParse(req.body);
  if (!parsed.success || parsed.data.permissionConfirmed !== true) {
    res.status(400).json({ error: "Explicit permission for the quote and attribution must be confirmed" });
    return;
  }
  const quote = parsed.data.quote.trim();
  const attribution = parsed.data.attribution.trim();
  const permissionRecord = parsed.data.permissionRecord.trim();
  if (!quote || !attribution || !permissionRecord) {
    res.status(400).json({ error: "Quote, attribution and permission record are required" });
    return;
  }
  const now = new Date();
  const [row] = await db.insert(memberStoriesTable).values({
    quote, attribution, permissionRecord,
    permissionRecordedAt: now, permissionRecordedBy: req.userId!, publishedAt: now,
  }).returning();
  res.set("Cache-Control", "private, no-store");
  res.status(201).json(PublishMemberStoryResponse.parse(ownerStory(row)));
});

router.post("/member-stories/:storyId/removal-request", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.storyId) ? req.params.storyId[0] : req.params.storyId;
  const id = Number(raw);
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid story ID" });
    return;
  }
  const parsed = RequestMemberStoryRemovalBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.note.trim() || parsed.data.note.trim().length > 500) {
    res.status(400).json({ error: "Tell us how this story is connected to you (up to 500 characters)" });
    return;
  }
  const note = parsed.data.note.trim();
  let email: string | null;
  try {
    const user = await clerkClient.users.getUser(req.userId!);
    email = user.primaryEmailAddress?.emailAddress ?? null;
  } catch (err) {
    req.log.error({ err }, "Could not identify story removal requester");
    res.status(503).json({ error: "Could not verify your account. Please try again." });
    return;
  }
  const result = await db.transaction(async tx => {
    // Serialize requests by account so parallel submissions cannot bypass the limit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.userId!}))`);
    const [recent] = await tx.select({ id: memberStoriesTable.id }).from(memberStoriesTable)
      .where(and(eq(memberStoriesTable.removalRequestedBy, req.userId!), gt(memberStoriesTable.removalRequestedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))))
      .limit(1);
    if (recent) return { limited: true as const };
    const [row] = await tx.update(memberStoriesTable).set({
      withdrawnAt: new Date(),
      withdrawnBy: req.userId!,
      removalRequestedAt: new Date(),
      removalRequestedBy: req.userId!,
      removalRequesterEmail: email,
      removalRequestNote: note,
    }).where(and(eq(memberStoriesTable.id, id), isNull(memberStoriesTable.withdrawnAt))).returning({ id: memberStoriesTable.id });
    return { limited: false as const, row };
  });
  if (result.limited) {
    res.status(429).json({ error: "You can submit one story removal request every 24 hours. Please contact the owner directly if another story needs urgent removal." });
    return;
  }
  const { row } = result;
  if (!row) {
    res.status(404).json({ error: "This story is no longer published" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json(RequestMemberStoryRemovalResponse.parse({ storyId: row.id, hidden: true }));
});

router.post("/member-stories/:storyId/withdraw", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.storyId) ? req.params.storyId[0] : req.params.storyId;
  const id = Number(raw);
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid story ID" });
    return;
  }
  const [row] = await db.update(memberStoriesTable).set({
    withdrawnAt: new Date(),
    withdrawnBy: req.userId!,
  }).where(and(eq(memberStoriesTable.id, id), isNull(memberStoriesTable.withdrawnAt))).returning();
  if (!row) {
    res.status(404).json({ error: "Published story not found" });
    return;
  }
  res.json(WithdrawMemberStoryResponse.parse(ownerStory(row)));
});

router.post("/member-stories/:storyId/removal-review", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.storyId) ? req.params.storyId[0] : req.params.storyId;
  const id = Number(raw);
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid story ID" });
    return;
  }
  const parsed = ReviewMemberStoryRemovalBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.note.trim() || parsed.data.note.trim().length > 2000) {
    res.status(400).json({ error: "Review note is required (up to 2000 characters)" });
    return;
  }
  const note = parsed.data.note.trim();
  const [row] = await db.update(memberStoriesTable).set({
    removalReviewOutcome: parsed.data.outcome,
    removalReviewNote: note,
    removalReviewedAt: new Date(),
    removalReviewedBy: req.userId!,
  }).where(and(
    eq(memberStoriesTable.id, id),
    isNull(memberStoriesTable.removalReviewOutcome),
    isNull(memberStoriesTable.removalReviewedAt),
    sql`${memberStoriesTable.removalRequestedAt} IS NOT NULL`,
    sql`${memberStoriesTable.withdrawnAt} IS NOT NULL`,
  )).returning();
  if (!row) {
    res.status(404).json({ error: "Hidden, unreviewed removal claim not found" });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  res.json(ReviewMemberStoryRemovalResponse.parse(ownerStory(row)));
});

router.post("/member-stories/:storyId/removal-review/corrections", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.storyId) ? req.params.storyId[0] : req.params.storyId;
  const id = Number(raw);
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid story ID" });
    return;
  }
  const parsed = CorrectMemberStoryRemovalReviewBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.note.trim() || parsed.data.note.trim().length > 2000 ||
      !Number.isSafeInteger(parsed.data.expectedReviewId) || parsed.data.expectedReviewId < 0) {
    res.status(400).json({ error: "A correction reason and current review ID are required" });
    return;
  }
  const result = await db.transaction(async tx => {
    // Lock the story before checking the current revision. A second owner request
    // cannot append against a stale decision or silently duplicate a retry.
    const [story] = await tx.select().from(memberStoriesTable)
      .where(eq(memberStoriesTable.id, id)).for("update");
    if (!story?.removalRequestedAt || !story.withdrawnAt || !story.removalReviewOutcome ||
        !story.removalReviewedAt || !story.removalReviewNote || !story.removalReviewedBy) {
      return { status: 404 as const };
    }
    const [latest] = await tx.select({ id: memberStoryReviewCorrectionsTable.id })
      .from(memberStoryReviewCorrectionsTable)
      .where(eq(memberStoryReviewCorrectionsTable.storyId, id))
      .orderBy(desc(memberStoryReviewCorrectionsTable.id)).limit(1);
    if ((latest?.id ?? 0) !== parsed.data.expectedReviewId) return { status: 409 as const };
    await tx.insert(memberStoryReviewCorrectionsTable).values({
      storyId: id, outcome: parsed.data.outcome, note: parsed.data.note.trim(), reviewedBy: req.userId!,
    });
    const corrections = await tx.select().from(memberStoryReviewCorrectionsTable)
      .where(eq(memberStoryReviewCorrectionsTable.storyId, id))
      .orderBy(asc(memberStoryReviewCorrectionsTable.id));
    return { status: 200 as const, story, corrections };
  });
  if (result.status === 404) {
    res.status(404).json({ error: "Hidden reviewed removal claim not found" });
    return;
  }
  if (result.status === 409) {
    res.status(409).json({ error: "Review changed. Refresh the story before correcting it." });
    return;
  }
  res.set("Cache-Control", "private, no-store");
  res.json(CorrectMemberStoryRemovalReviewResponse.parse(ownerStory(result.story, result.corrections)));
});

export default router;