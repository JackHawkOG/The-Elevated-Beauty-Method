import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { lessonsTable } from "./lessons";

export const lessonCompletionsTable = pgTable("lesson_completions", {
  userId: text("user_id").notNull(),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.lessonId] })]);