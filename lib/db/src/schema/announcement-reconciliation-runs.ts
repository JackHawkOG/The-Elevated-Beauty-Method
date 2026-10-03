import { pgTable, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Historical IDs intentionally have no foreign keys: deleting a source row
// must not erase or change the evidence of a committed reconciliation.
export const announcementReconciliationRunsTable = pgTable("announcement_reconciliation_runs", {
  id: serial("id").primaryKey(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  version: integer("version").default(1).notNull(),
  repairedIds: jsonb("repaired_ids").$type<number[]>().notNull(),
  review: jsonb("review").$type<{ announcementId: number; activityIds: number[]; reason: string }[]>().notNull(),
});

export const insertAnnouncementReconciliationRunSchema = createInsertSchema(announcementReconciliationRunsTable)
  .omit({ id: true, recordedAt: true, version: true });
export type InsertAnnouncementReconciliationRun = z.infer<typeof insertAnnouncementReconciliationRunSchema>;
export type AnnouncementReconciliationRun = typeof announcementReconciliationRunsTable.$inferSelect;