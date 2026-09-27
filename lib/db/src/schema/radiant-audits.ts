import { pgTable, text, timestamp, bigserial, index, uuid, jsonb, primaryKey } from "drizzle-orm/pg-core";
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

export const radiantAuditHistoryTable = pgTable("radiant_audit_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  clerkId: text("clerk_id").notNull().references(() => usersTable.clerkId),
  routineChecks: text("routine_checks").array().notNull(),
  valuesChecks: text("values_checks").array().notNull(),
  beautyTrend: text("beauty_trend").notNull(),
  masteryGoal: text("mastery_goal").notNull(),
  researchTime: text("research_time").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
}, table => [index("radiant_audit_history_member_idx").on(table.clerkId, table.id)]);

export const insertRadiantAuditHistorySchema = createInsertSchema(radiantAuditHistoryTable).omit({ id: true });
export type InsertRadiantAuditHistory = z.infer<typeof insertRadiantAuditHistorySchema>;
export type RadiantAuditHistory = typeof radiantAuditHistoryTable.$inferSelect;

export const radiantAuditSubmissionsTable = pgTable("radiant_audit_submissions", {
  clerkId: text("clerk_id").notNull().references(() => usersTable.clerkId),
  submissionId: uuid("submission_id").notNull(),
  answers: jsonb("answers").notNull(),
  result: jsonb("result"),
}, table => [primaryKey({ columns: [table.clerkId, table.submissionId] })]);