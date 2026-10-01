import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull(),
  bio: text("bio"),
  profileVersion: text("profile_version").default(sql`gen_random_uuid()::text`).notNull(),
  avatarUrl: text("avatar_url"),
  membershipTier: text("membership_tier").default("Free").notNull(),
  skinType: text("skin_type"),
  undertone: text("undertone"),
  featureNeeds: text("feature_needs").array(),
  lifeStage: text("life_stage"),
  visibilityGoal: text("visibility_goal"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
