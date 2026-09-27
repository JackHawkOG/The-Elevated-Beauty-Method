import { activityTable, announcementsTable, db } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

type AnnouncementRow = {
  id: number;
  title: string;
  authorName: string;
  actorId: string | null;
  requestKey: string | null;
  createdAt: Date;
};

type ActivityRow = {
  id: number;
  entityTitle: string;
  actorName: string;
  createdAt: Date;
  sourceAnnouncementId: number | null;
};

type Review = { announcementId: number; activityIds: number[]; reason: string };

// A title is evidence, not an ID. Normalize only the known trademark-spacing
// variation, and refuse to assign a feed entry when a title occurs more than once.
function titleKey(title: string): string {
  return title.normalize("NFC").replace(/\s+™/g, "™");
}

export function planAnnouncementActivityRepair(
  announcements: AnnouncementRow[],
  activities: ActivityRow[],
): { missing: AnnouncementRow[]; review: Review[] } {
  const byTitle = new Map<string, AnnouncementRow[]>();
  const activityByTitle = new Map<string, ActivityRow[]>();
  const linkedIds = new Set(activities.flatMap(row => row.sourceAnnouncementId === null ? [] : [row.sourceAnnouncementId]));
  for (const announcement of announcements) {
    const key = titleKey(announcement.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), announcement]);
  }
  for (const activity of activities) {
    const key = titleKey(activity.entityTitle);
    activityByTitle.set(key, [...(activityByTitle.get(key) ?? []), activity]);
  }

  const missing: AnnouncementRow[] = [];
  const review: Review[] = [];
  for (const announcement of announcements) {
    // Newer posts have atomic activity writes. Only legacy rows need repair.
    if (announcement.actorId !== null || announcement.requestKey !== null) continue;
    if (linkedIds.has(announcement.id)) continue;
    const key = titleKey(announcement.title);
    const matches = activityByTitle.get(key) ?? [];
    let reason: string | undefined;
    if ((byTitle.get(key)?.length ?? 0) !== 1) {
      reason = "repeated announcement title";
    } else if (matches.length > 1) {
      reason = "multiple feed entries with this title";
    } else if (matches.length === 1) {
      const activity = matches[0];
      const delay = activity.createdAt.getTime() - announcement.createdAt.getTime();
      if (activity.actorName !== announcement.authorName || delay < 0 || delay > 5 * 60_000) {
        reason = "feed entry has a different author or timestamp";
      }
    } else {
      missing.push(announcement);
    }
    if (reason) review.push({ announcementId: announcement.id, activityIds: matches.map(row => row.id), reason });
  }
  return { missing, review };
}

export async function reconcileAnnouncementActivity(): Promise<void> {
  const result = await db.transaction(async tx => {
    // Serialize startup repairs across server instances; reread after acquiring
    // the lock so a second startup sees the first one's newly inserted rows.
    await tx.execute(sql`select pg_advisory_xact_lock(750075)`);
    const announcements = await tx.select().from(announcementsTable);
    const activities = await tx.select().from(activityTable).where(eq(activityTable.type, "announcement"));
    const plan = planAnnouncementActivityRepair(announcements, activities);
    for (const announcement of plan.missing) {
      await tx.insert(activityTable).values({
        type: "announcement",
        description: "posted an announcement",
        actorName: announcement.authorName,
        entityTitle: announcement.title,
        sourceAnnouncementId: announcement.id,
        createdAt: announcement.createdAt,
      });
    }
    return { repairedIds: plan.missing.map(row => row.id), review: plan.review };
  });
  logger.info(result, "Legacy announcement activity reconciliation");
  if (result.review.length) {
    logger.warn({ review: result.review }, "Ambiguous legacy announcement activity requires manual review");
  }
}