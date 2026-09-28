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
