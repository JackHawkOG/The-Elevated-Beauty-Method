import { Router } from "express";
import { db, announcementsTable, usersTable, activityTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  ListAnnouncementsQueryParams,
  ListAnnouncementsResponse,
  CreateAnnouncementBody,
  CreateAnnouncementResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { withBrandTrademarks } from "../lib/brand-copy";

const router = Router();

// GET /announcements
router.get("/announcements", async (req, res): Promise<void> => {
  const parsed = ListAnnouncementsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit ?? 20;

  const rows = await db.select().from(announcementsTable)
    .orderBy(desc(announcementsTable.pinned), desc(announcementsTable.createdAt))
    .limit(limit);

  res.json(ListAnnouncementsResponse.parse(rows.map(r => ({
    ...r,
    title: withBrandTrademarks(r.title),
    body: withBrandTrademarks(r.body),
    createdAt: r.createdAt?.toISOString(),
  }))));
});

// POST /announcements
router.post("/announcements", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateAnnouncementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Get user display name for authorName
  const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
  const authorName = dbUser?.displayName ?? "Community Member";

  const [announcement] = await db.insert(announcementsTable)
    .values({ ...parsed.data, authorName })
    .returning();

  // Log activity
  await db.insert(activityTable).values({
    type: "announcement",
    description: `posted an announcement`,
    actorName: authorName,
    entityTitle: announcement.title,
  }).catch(() => {});

  res.status(201).json(CreateAnnouncementResponse.parse({ ...announcement, createdAt: announcement.createdAt?.toISOString() }));
});

export default router;
