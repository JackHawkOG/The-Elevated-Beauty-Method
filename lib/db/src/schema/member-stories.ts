import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const memberStoriesTable = pgTable("member_stories", {
  id: serial("id").primaryKey(),
  quote: text("quote").notNull(),
  attribution: text("attribution").notNull(),
  permissionRecord: text("permission_record").notNull(),
  permissionRecordedBy: text("permission_recorded_by").notNull(),
  permissionRecordedAt: timestamp("permission_recorded_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  withdrawnBy: text("withdrawn_by"),
  removalRequestedAt: timestamp("removal_requested_at", { withTimezone: true }),
  removalRequestedBy: text("removal_requested_by"),
  removalRequesterEmail: text("removal_requester_email"),
  removalRequestNote: text("removal_request_note"),
  removalReviewOutcome: text("removal_review_outcome"),
  removalReviewNote: text("removal_review_note"),
  removalReviewedAt: timestamp("removal_reviewed_at", { withTimezone: true }),
  removalReviewedBy: text("removal_reviewed_by"),
});

export const insertMemberStorySchema = createInsertSchema(memberStoriesTable).omit({ id: true });
export type InsertMemberStory = z.infer<typeof insertMemberStorySchema>;
export type MemberStory = typeof memberStoriesTable.$inferSelect;

// The first decision stays on member_stories for compatibility; later decisions
// are append-only, so neither a correction nor a retry erases the audit trail.
export const memberStoryReviewCorrectionsTable = pgTable("member_story_review_corrections", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id").notNull().references(() => memberStoriesTable.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  note: text("note").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: text("reviewed_by").notNull(),
});