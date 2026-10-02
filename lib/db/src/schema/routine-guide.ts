import { pgTable, text, boolean, timestamp, integer, primaryKey, index, uuid, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const routineGuideClaimsTable = pgTable("routine_guide_claims", {
  requestId: uuid("request_id").primaryKey(),
  emailHash: text("email_hash").notNull(),
  consent: boolean("consent").notNull(),
  consentText: text("consent_text").notNull(),
  guideVersion: text("guide_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("routine_guide_claims_consent_true", sql`${table.consent} = true`),
  index("routine_guide_claims_email_idx").on(table.emailHash, table.createdAt),
]);

export const routineGuideDeliveriesTable = pgTable("routine_guide_deliveries", {
  guideVersion: text("guide_version").notNull(),
  emailHash: text("email_hash").notNull(),
  email: text("email").notNull(),
  state: text("state", { enum: ["processing", "sent", "failed", "uncertain"] }).notNull(),
  providerIdempotencyKey: text("provider_idempotency_key").notNull().unique(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.guideVersion, table.emailHash] }),
  check("routine_guide_deliveries_state_valid", sql`${table.state} IN ('processing', 'sent', 'failed', 'uncertain')`),
  check("routine_guide_deliveries_attempt_count_positive", sql`${table.attemptCount} > 0`),
  index("routine_guide_deliveries_state_idx").on(table.state, table.leaseUntil),
]);

export const routineGuideRateLimitsTable = pgTable("routine_guide_rate_limits", {
  keyHash: text("key_hash").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
}, table => [
  primaryKey({ columns: [table.keyHash, table.windowStartedAt] }),
  check("routine_guide_rate_limits_attempts_nonnegative", sql`${table.attempts} >= 0`),
]);

export const insertRoutineGuideClaimSchema = createInsertSchema(routineGuideClaimsTable);
export type InsertRoutineGuideClaim = z.infer<typeof insertRoutineGuideClaimSchema>;
export type RoutineGuideClaim = typeof routineGuideClaimsTable.$inferSelect;
export type RoutineGuideDelivery = typeof routineGuideDeliveriesTable.$inferSelect;