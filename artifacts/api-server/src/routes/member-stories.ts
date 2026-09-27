import { Router, type Request, type Response, type NextFunction } from "express";
import { clerkClient } from "@clerk/express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, memberStoriesTable } from "@workspace/db";
import {
  ListPublishedMemberStoriesResponse,
  ListManagedMemberStoriesResponse,
  PublishMemberStoryBody,
  PublishMemberStoryResponse,
  WithdrawMemberStoryResponse,
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

function ownerStory(row: typeof memberStoriesTable.$inferSelect) {
  return {
    ...row,
    permissionRecordedAt: row.permissionRecordedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
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
  res.set("Cache-Control", "no-store");
  const rows = await db.select().from(memberStoriesTable).orderBy(desc(memberStoriesTable.publishedAt));
  res.json(ListManagedMemberStoriesResponse.parse(rows.map(ownerStory)));
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
    permissionRecordedBy: req.userId!,
    permissionRecordedAt: now,
    publishedAt: now,
  }).returning();
  res.status(201).json(PublishMemberStoryResponse.parse(ownerStory(row)));
});

router.post("/member-stories/:storyId/withdraw", requireAuth, requireOwner, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.storyId) ? req.params.storyId[0] : req.params.storyId;
  const id = Number(raw);
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid story ID" });
    return;
  }
  const [row] = await db.update(memberStoriesTable).set({
    withdrawnAt: new Date(), withdrawnBy: req.userId!,
  }).where(and(eq(memberStoriesTable.id, id), isNull(memberStoriesTable.withdrawnAt))).returning();
  if (!row) {
    res.status(404).json({ error: "Published story not found" });
    return;
  }
  res.json(WithdrawMemberStoryResponse.parse(ownerStory(row)));
});

export default router;