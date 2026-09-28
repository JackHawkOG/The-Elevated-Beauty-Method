import { pgTable, integer, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { announcementsTable } from "./announcements";

export const activityTable = pgTable("activity", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // "enrollment" | "announcement" | "completion"
  description: text("description").notNull(),
  actorName: text("actor_name").notNull(),
  entityTitle: text("entity_title").notNull(),
  sourceAnnouncementId: integer("source_announcement_id").references(() => announcementsTable.id),
  sourceEvidence: text("source_evidence"),
  sourceReviewedBy: text("source_reviewed_by"),
  sourceReviewedAt: timestamp("source_reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [uniqueIndex("activity_source_announcement_unique").on(table.sourceAnnouncementId)]);

export const insertActivitySchema = createInsertSchema(activityTable).omit({ id: true, createdAt: true });
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activityTable.$inferSelect;

// Corrections are append-only. Keep the superseded reviewer and evidence even
// when the current link is cleared or assigned to a different announcement.
export const announcementActivityCorrectionsTable = pgTable("announcement_activity_corrections", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id").notNull().references(() => activityTable.id, { onDelete: "cascade" }),
  fromAnnouncementId: integer("from_announcement_id").references(() => announcementsTable.id),
  toAnnouncementId: integer("to_announcement_id").references(() => announcementsTable.id),
  previousEvidence: text("previous_evidence"),
  previousReviewedBy: text("previous_reviewed_by"),
  previousReviewedAt: timestamp("previous_reviewed_at"),
  evidence: text("evidence"),
  rationale: text("rationale").notNull(),
  correctedBy: text("corrected_by").notNull(),
  correctedAt: timestamp("corrected_at").notNull().defaultNow(),
});
