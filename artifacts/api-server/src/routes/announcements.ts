import { Router } from "express";
import { db, announcementsTable, usersTable, activityTable } from "@workspace/db";
import { eq, desc, and, or, lt, ilike } from "drizzle-orm";
import {
  ListAnnouncementsQueryParams,
  ListAnnouncementsResponse,
  GetAnnouncementResponse,
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
  const after = parsed.data.after;
  const search = parsed.data.search?.trim();
  // Treat user input literally, including SQL LIKE wildcards and escape characters.
  const pattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : undefined;
  const searchFilter = pattern ? or(
    ilike(announcementsTable.title, pattern),
    ilike(announcementsTable.body, pattern),
  ) : undefined;
  let cursor: typeof announcementsTable.$inferSelect | undefined;
  if (after !== undefined) {
    [cursor] = await db.select().from(announcementsTable)
      .where(and(eq(announcementsTable.id, after), searchFilter)).limit(1);
    if (!cursor) {
      res.status(400).json({ error: "Invalid announcement cursor" });
      return;
    }
  }

  const rows = await db.select().from(announcementsTable)
    .where(and(searchFilter, cursor ? or(
      // Once past the pinned group, only unpinned posts can follow.
      ...(cursor.pinned ? [eq(announcementsTable.pinned, false)] : []),
      and(
        eq(announcementsTable.pinned, cursor.pinned),
        or(
          lt(announcementsTable.createdAt, cursor.createdAt),
          and(eq(announcementsTable.createdAt, cursor.createdAt), lt(announcementsTable.id, cursor.id)),
        ),
      ),
    ) : undefined))
    .orderBy(desc(announcementsTable.pinned), desc(announcementsTable.createdAt), desc(announcementsTable.id))
    .limit(limit);

  res.json(ListAnnouncementsResponse.parse(rows.map(r => ({
    ...r,
    title: withBrandTrademarks(r.title),
    body: withBrandTrademarks(r.body),
    createdAt: r.createdAt?.toISOString(),
  }))));
});

router.get("/announcements/:announcementId", async (req, res): Promise<void> => {
  const id = Number(req.params.announcementId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(404).json({ error: "Announcement not found" });
    return;
  }
  const [announcement] = await db.select().from(announcementsTable)
    .where(eq(announcementsTable.id, id)).limit(1);
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found" });
    return;
  }
  res.json(GetAnnouncementResponse.parse({
    ...announcement,
    title: withBrandTrademarks(announcement.title),
    body: withBrandTrademarks(announcement.body),
    createdAt: announcement.createdAt.toISOString(),
  }));
});

// POST /announcements
router.post("/announcements", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateAnnouncementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const requestKey = req.header("Idempotency-Key");
  if (!requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
    res.status(400).json({ error: "A UUID Idempotency-Key header is required" });
    return;
  }

  // Get user display name for authorName
  const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.clerkId, req.userId!)).limit(1);
  const authorName = dbUser?.displayName ?? "Community Member";

  const { announcement, created } = await db.transaction(async (tx) => {
    const [inserted] = await tx.insert(announcementsTable)
      .values({ ...parsed.data, authorName, actorId: req.userId!, requestKey })
      .onConflictDoNothing({ target: [announcementsTable.actorId, announcementsTable.requestKey] })
      .returning();
    if (!inserted) {
      const [existing] = await tx.select().from(announcementsTable).where(and(
        eq(announcementsTable.actorId, req.userId!),
        eq(announcementsTable.requestKey, requestKey),
      )).limit(1);
      if (!existing) throw new Error("Announcement missing after request key conflict");
      return { announcement: existing, created: false };
    }
    try {
      await tx.insert(activityTable).values({
        type: "announcement",
        description: "posted an announcement",
        actorName: authorName,
        entityTitle: inserted.title,
        sourceAnnouncementId: inserted.id,
      });
    } catch (err) {
      req.log.error({ err, announcementId: inserted.id }, "Announcement activity write failed; rolling back announcement");
      throw err;
    }
    return { announcement: inserted, created: true };
  });
  if (announcement.title !== parsed.data.title || announcement.body !== parsed.data.body ||
    announcement.pinned !== (parsed.data.pinned ?? false)) {
    res.status(409).json({ error: "Idempotency-Key was already used for a different announcement" });
    return;
  }

  res.status(created ? 201 : 200).json(CreateAnnouncementResponse.parse({ ...announcement, createdAt: announcement.createdAt?.toISOString() }));
});

export default router;
