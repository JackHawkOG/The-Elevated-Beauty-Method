import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const radiantAuditsTable = pgTable("radiant_audits", {
  clerkId: text("clerk_id").primaryKey().references(() => usersTable.clerkId),
  routineChecks: text("routine_checks").array().notNull(),
  valuesChecks: text("values_checks").array().notNull(),
  beautyTrend: text("beauty_trend").notNull(),
  masteryGoal: text("mastery_goal").notNull(),
  researchTime: text("research_time").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRadiantAuditSchema = createInsertSchema(radiantAuditsTable).omit({ completedAt: true });
export type InsertRadiantAudit = z.infer<typeof insertRadiantAuditSchema>;
export type RadiantAudit = typeof radiantAuditsTable.$inferSelect;