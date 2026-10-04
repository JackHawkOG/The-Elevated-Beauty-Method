import { randomUUID } from "node:crypto";
import { afterAll, expect, test, vi } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { db, pool, categoriesTable, coursesTable, lessonsTable, enrollmentsTable } from "@workspace/db";
import * as schema from "../../../../lib/db/src/schema";
import { requireDevelopmentDatabase } from "../routes/test-development-database";
import { approvedTopicLessons } from "./approved-topic-lessons";
import { ensureMemberJourneyContent } from "./seed-member-journey";

// Only replace the connection: the seeder still executes real Drizzle/Postgres
// queries, but cannot fall through to the workspace's existing course tables.
const isolated = vi.hoisted(() => ({ database: undefined as NodePgDatabase<typeof schema> | undefined }));
vi.mock("@workspace/db", async importOriginal => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...original,
    get db() {
      if (!isolated.database) throw new Error("Seeding requires the isolated test database");
      return isolated.database;
    },
  };
});

afterAll(async () => { await pool.end(); });

async function withIsolatedJourney(callback: () => Promise<void>) {
  requireDevelopmentDatabase();
  const client = await pool.connect();
  const name = `seed_journey_${randomUUID().replaceAll("-", "")}`;
  try {
    // Roll back the entire schema, including its own sequences, even if an
    // assertion fails. There is deliberately no public search-path fallback.
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${name}"`);
    await client.query("SELECT set_config('search_path', $1, true)", [name]);
    await client.query(`
      CREATE TABLE categories (
        id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
        icon text NOT NULL DEFAULT 'BookOpen', description text,
        created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE courses (
        id serial PRIMARY KEY, title text NOT NULL, approved_topic_key text,
        description text NOT NULL, category_id integer NOT NULL REFERENCES categories(id),
        difficulty text NOT NULL DEFAULT 'Beginner', instructor_name text NOT NULL,
        thumbnail_url text, is_featured boolean NOT NULL DEFAULT false,
        access_tier text NOT NULL DEFAULT 'Elevated', transformation_story text,
        published_at timestamptz, created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE lessons (
        id serial PRIMARY KEY, course_id integer NOT NULL REFERENCES courses(id),
        title text NOT NULL, content text, video_url text,
        sort_order integer NOT NULL DEFAULT 0, duration_minutes integer NOT NULL DEFAULT 10,
        published_at timestamptz, created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE enrollments (
        id serial PRIMARY KEY, user_id text NOT NULL, course_id integer NOT NULL REFERENCES courses(id),
        completed_lessons integer NOT NULL DEFAULT 0, last_lesson_id integer,
        enrolled_at timestamp NOT NULL DEFAULT now(),
        UNIQUE (user_id, course_id)
      );
    `);
    isolated.database = drizzle(client, { schema });
    await callback();
  } finally {
    isolated.database = undefined;
    try {
      await client.query("ROLLBACK");
    } finally {
      // Never return session-local fixture state to another integration test.
      client.release(true);
    }
  }
}

test.each([false, true])(
  "repeated seeding preserves a renamed reviewed course and withholds edited lesson copy (legacy backfill: %s)",
  async backfillLegacy => {
    requireDevelopmentDatabase();
    await withIsolatedJourney(async () => {
      await ensureMemberJourneyContent();
      const topic = approvedTopicLessons[0];
      expect(topic).toBeDefined();
      const [course] = await db.select().from(coursesTable)
        .where(eq(coursesTable.approvedTopicKey, topic.title));
      const [lesson] = await db.select().from(lessonsTable)
        .where(eq(lessonsTable.courseId, course.id));
      expect(course.publishedAt).toBeInstanceOf(Date);
      expect(lesson).toMatchObject({ title: topic.title, content: topic.content });
      expect(lesson.publishedAt).toBeInstanceOf(Date);

      const enrollments = await db.insert(enrollmentsTable).values([
        { userId: "isolated-learner-one", courseId: course.id, completedLessons: 1, lastLessonId: lesson.id },
        { userId: "isolated-learner-two", courseId: course.id, completedLessons: 0 },
      ]).returning();
      const renamedTitle = `Renamed reviewed course ${randomUUID()}`;
      const editedCopy = "Changed teaching text that has not been reviewed.";
      await db.update(coursesTable).set({ title: renamedTitle }).where(eq(coursesTable.id, course.id));
      // Leave the publication timestamp set: startup must actively withhold
      // changed copy, not merely preserve an already-unpublished draft.
      await db.update(lessonsTable).set({ content: editedCopy }).where(eq(lessonsTable.id, lesson.id));

      const originalCourses = await db.select().from(coursesTable).orderBy(coursesTable.id);
      const originalLessons = await db.select().from(lessonsTable).orderBy(lessonsTable.id);
      const originalCategories = await db.select().from(categoriesTable).orderBy(categoriesTable.id);
      for (let restart = 0; restart < 3; restart++) {
        await ensureMemberJourneyContent(backfillLegacy);
        const courses = await db.select().from(coursesTable).orderBy(coursesTable.id);
        // Backfill intentionally refreshes other approved publication dates.
        // All other fields and the renamed course's full row must stay intact.
        expect(courses).toEqual(originalCourses.map(row =>
          row.id !== course.id && row.publishedAt ? { ...row, publishedAt: expect.any(Date) } : row,
        ));
        expect(courses.filter(row => row.approvedTopicKey === topic.title)).toEqual([
          { ...course, title: renamedTitle },
        ]);
        expect(courses.filter(row => row.title === topic.title)).toEqual([]);
        expect(await db.select().from(enrollmentsTable).orderBy(enrollmentsTable.id)).toEqual(enrollments);
        expect(await db.select().from(lessonsTable).orderBy(lessonsTable.id)).toEqual(
          originalLessons.map(row => ({
            ...row,
            publishedAt: row.id === lesson.id ? null : row.publishedAt ? expect.any(Date) : null,
          })),
        );
        expect(await db.select().from(categoriesTable).orderBy(categoriesTable.id)).toEqual(originalCategories);
      }
    });
  },
  30_000,
);