import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { coursesTable } from "./courses";

export const enrollmentsTable = pgTable("enrollments", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id),
  completedLessons: integer("completed_lessons").notNull().default(0),
  lastLessonId: integer("last_lesson_id"),
  enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
});

export const insertEnrollmentSchema = createInsertSchema(enrollmentsTable).omit({ id: true, enrolledAt: true });
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type Enrollment = typeof enrollmentsTable.$inferSelect;
