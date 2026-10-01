import { afterAll, beforeAll, expect, test } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { announcementsTable, db, pool } from "@workspace/db";
import { ensureAnnouncementSchema } from "../lib/ensure-announcement-schema";
import { requireDevelopmentDatabase } from "./test-development-database";

const marker = `search-${randomUUID()}`;
const ids: number[] = [];
let server: Server | undefined;
let baseUrl: string;
let expected: number[];

beforeAll(async () => {
  requireDevelopmentDatabase();
  await ensureAnnouncementSchema();
  const { default: router } = await import("./announcements");
  const app = express();
  app.use(router);
  server = app.listen(0);
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const rows = await db.insert(announcementsTable).values([
    { title: `${marker} title`, body: "Title match", pinned: true },
    { title: "Body match", body: `${marker.toUpperCase()} body`, pinned: true },
    { title: "Older body match", body: marker, pinned: false },
    { title: `${marker} oldest title`, body: "Archive", pinned: false },
    { title: "Nonmatching", body: "Do not include me", pinned: true },
    { title: `${marker} literal %_\\`, body: "Special characters", pinned: false },
  ].map((row, i) => ({
    ...row, authorName: "Search fixture",
    createdAt: new Date(i === 3 ? "2000-01-01T00:00:00Z" : "2001-01-01T00:00:00Z"),
  }))).returning();
  ids.push(...rows.map(row => row.id));
  expected = [rows[1].id, rows[0].id, rows[5].id, rows[2].id, rows[3].id];
});

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
    if (ids.length) await db.delete(announcementsTable).where(inArray(announcementsTable.id, ids));
  } finally {
    await pool.end();
  }
});

async function page(search: string, after?: number, limit = 2) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  if (after !== undefined) params.set("after", String(after));
  const response = await fetch(`${baseUrl}/announcements?${params}`);
  return { status: response.status, data: await response.json() };
}

test("searches the whole archive in title and body with pinned-first cursor pages", async () => {
  const found: number[] = [];
  let after: number | undefined;
  for (let i = 0; i < 4; i++) {
    const result = await page(`  ${marker.toUpperCase()}  `, after);
    expect(result.status).toBe(200);
    const rows = result.data as Array<{ id: number }>;
    found.push(...rows.map(row => row.id));
    if (rows.length < 2) break;
    after = rows[rows.length - 1].id;
  }
  expect(found).toEqual(expected);
  expect(new Set(found).size).toBe(found.length);
});

test("matches wildcard characters literally and reports no matches", async () => {
  const literal = await page(`${marker} literal %_\\`);
  expect(literal.status).toBe(200);
  expect((literal.data as Array<{ id: number }>).map(row => row.id)).toEqual([ids[5]]);
  expect((await page(`${marker}-missing`)).data).toEqual([]);
});

test("rejects an oversized search and a cursor from outside the filtered results", async () => {
  expect((await page("x".repeat(201))).status).toBe(400);
  expect((await page(marker, ids[4])).status).toBe(400);
  expect((await page(marker, ids[3])).data).toEqual([]);
});

test("a blank search preserves the unfiltered archive", async () => {
  const plain = await fetch(`${baseUrl}/announcements?limit=2`);
  const blank = await page("   ");
  expect(blank.status).toBe(200);
  expect(blank.data).toEqual(await plain.json());
});