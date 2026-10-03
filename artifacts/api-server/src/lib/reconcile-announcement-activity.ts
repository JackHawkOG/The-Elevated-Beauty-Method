import { activityTable, announcementsTable, announcementActivityCorrectionsTable, announcementReconciliationRunsTable, db } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

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
export type AnnouncementActivityRepairResult = { repairedIds: number[]; review: Review[] };

// A title is evidence, not an ID. Normalize only the known trademark-spacing
// variation, and refuse to assign a feed entry when a title occurs more than once.
function titleKey(title: string): string {
  return title.normalize("NFC").replace(/\s+™/g, "™");
}

export function planAnnouncementActivityRepair(
  announcements: AnnouncementRow[],
  activities: ActivityRow[],
  correctedAnnouncementIds: Set<number> = new Set(),
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
    if (correctedAnnouncementIds.has(announcement.id)) {
      reason = "previous feed assignment was corrected";
    } else if ((byTitle.get(key)?.length ?? 0) !== 1) {
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

export async function reconcileAnnouncementActivity(database: Omit<typeof db, "$client"> = db): Promise<AnnouncementActivityRepairResult> {
  return database.transaction(async tx => {
    // Serialize startup repairs across server instances; reread after acquiring
    // the lock so a second startup sees the first one's newly inserted rows.
    await tx.execute(sql`select pg_advisory_xact_lock(750075)`);
    const announcements = await tx.select().from(announcementsTable);
    const activities = await tx.select().from(activityTable).where(eq(activityTable.type, "announcement"));
    const corrections = await tx.select({ from: announcementActivityCorrectionsTable.fromAnnouncementId, to: announcementActivityCorrectionsTable.toAnnouncementId }).from(announcementActivityCorrectionsTable);
    const corrected = new Set(corrections.flatMap(row => [row.from, row.to].filter((id): id is number => id !== null)));
    const plan = planAnnouncementActivityRepair(announcements, activities, corrected);
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
    const result = { repairedIds: plan.missing.map(row => row.id), review: plan.review };
    // Archive every outcome in the repair transaction. If this insert fails,
    // all repairs roll back; no later empty run can overwrite earlier evidence.
    await tx.insert(announcementReconciliationRunsTable).values(result);
    return result;
  });
}