import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import express from "express";
import { chromium, expect as browserExpect, type Browser, type BrowserContext } from "@playwright/test";
import { pool, type PoolClient } from "@workspace/db";
import type Stripe from "stripe";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { requireDevelopmentDatabase } from "../routes/test-development-database";
import { reconcileMemberships } from "./membership-reconciliation";
import { getUncachableStripeClient } from "./stripeClient";

const identity = vi.hoisted(() => ({ staff: "" }));
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({
    userId: identity.staff && req.header("authorization") === `Bearer ${identity.staff}` ? identity.staff : null,
  }),
  clerkClient: { users: { getUser: async (id: string) => {
    if (id !== identity.staff) throw new Error("Unowned staff identity");
    return { publicMetadata: { role: "admin" } };
  } } },
}));
vi.mock("./stripeClient", () => ({
  getUncachableStripeClient: vi.fn(() => { throw new Error("Real Stripe is forbidden in this check"); }),
  getStripeSync: vi.fn(() => { throw new Error("Real Stripe sync is forbidden in this check"); }),
}));

// Auth is isolated, not live Clerk coverage. HTTP authorization is tested in
// membership-invoice-history.test.ts. Here HTTP routing/SQL, committed recovery,
// the real page/hooks/layout, and Chromium focus/polling are integrated.
const queuePath = "/api/membership/pending-invoice-history";
const webBase = "http://127.0.0.1:4182";
let vite: ChildProcess | undefined;
let browser: Browser | undefined;
let viteOutput = "";

beforeAll(async () => {
  requireDevelopmentDatabase();
  vite = spawn("pnpm", [
    "--filter", "@workspace/edu-portal", "exec", "vite",
    "--config", "vite.invoice-history-test.config.ts", "--port", "4182", "--strictPort",
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  vite.stdout?.on("data", chunk => { viteOutput += String(chunk); });
  vite.stderr?.on("data", chunk => { viteOutput += String(chunk); });
  vite.on("error", error => { viteOutput += error.message; });
  await vi.waitFor(async () => {
    if (vite?.exitCode !== null) throw new Error(`Isolated Vite exited: ${viteOutput}`);
    expect((await fetch(`${webBase}/tests/invoice-history-harness.html`)).status).toBe(200);
  }, { timeout: 30000, interval: 100 });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium",
    args: ["--no-sandbox"], headless: true,
  });
}, 45000);

afterAll(async () => {
  requireDevelopmentDatabase();
  try {
    await browser?.close();
  } finally {
    if (vite?.pid) {
      try { process.kill(-vite.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
});

test.each(["focus", "interval"] as const)("open staff queue removes committed recovery on normal %s refresh", async refresh => {
  requireDevelopmentDatabase();
  const run = randomUUID();
  identity.staff = `invoice-history-staff-${run}`;
  const ended = `invoice-history-ended-${run}`;
  const waiting = `invoice-history-waiting-${run}`;
  const active = `invoice-history-active-${run}`;
  const subscription = `sub_invoice_history_${run}`;
  const client = await pool.connect();
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  let querySpy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    context = await browser!.newContext();
    // Explicitly owned fixtures shadow shared tables on ONE pinned connection.
    // Preserve them across COMMIT to test persisted recovery, but never release
    // this session into the pool: disconnect removes them, even after SIGKILL.
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE membership_checkouts (
      id integer PRIMARY KEY, clerk_id text, kind text, status text,
      stripe_subscription_id text, failed_months integer, last_failed_invoice text,
      invoice_history_pending boolean, invoice_history_retry_count integer,
      invoice_history_retry_at timestamptz
    ) ON COMMIT PRESERVE ROWS`);
    await client.query(`CREATE TEMP TABLE users (
      clerk_id text PRIMARY KEY, membership_tier text
    ) ON COMMIT PRESERVE ROWS`);
    await client.query("INSERT INTO users VALUES ($1, 'Free'), ($2, 'Free'), ($3, 'Elevated')", [ended, waiting, active]);
    await client.query(`INSERT INTO membership_checkouts VALUES
      (1, $1, 'founding', 'forfeited', $4, 0, NULL, true, 8, now() - interval '1 minute'),
      (2, $2, 'founding', 'forfeited', $5, 1, NULL, true, 2, now() + interval '1 day'),
      (3, $3, 'founding', 'confirmed', $6, 2, NULL, false, 0, NULL)`,
    [ended, waiting, active, subscription, `sub_waiting_${run}`, `sub_active_${run}`]);
    await client.query("COMMIT");
    async function snapshot() {
      return (await client.query(`SELECT m.*, u.membership_tier FROM membership_checkouts m
        JOIN users u USING (clerk_id) ORDER BY m.id`)).rows;
    }
    const before = await snapshot();
    querySpy = vi.spyOn(pool, "query").mockImplementation(((sql: string, params?: unknown[]) =>
      client.query(sql, params)) as typeof pool.query);
    const { default: router } = await import("../routes/membership");
    const app = express();
    app.use((req, _res, next) => {
      req.log = { error: vi.fn() } as unknown as express.Request["log"];
      next();
    });
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing isolated HTTP address");
    const endpoint = `http://127.0.0.1:${address.port}${queuePath}`;
    async function queue() {
      const response = await fetch(endpoint, { headers: { authorization: `Bearer ${identity.staff}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      return response.json() as Promise<{ memberships: Array<{ checkoutId: number }>; nextCursor: number | null }>;
    }
    expect((await queue()).memberships.map(row => row.checkoutId)).toEqual([1, 2]);
    const page = await context.newPage();
    const unexpected: string[] = [];
    const errors: string[] = [];
    let reads = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(staff => {
      localStorage.setItem("audit-test-account", staff);
      localStorage.setItem(`audit-test-role:${staff}`, "admin");
    }, identity.staff);
    // No browser request can reach a live backend, even if the layout changes.
    await page.route("**/api/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") {
        unexpected.push(`${request.method()} ${path}`);
        return route.abort();
      }
      if (path === queuePath) {
        expect(request.headers().authorization).toBe(`Bearer ${identity.staff}`);
        reads++;
        const response = await fetch(endpoint + new URL(request.url()).search, { headers: request.headers() });
        return route.fulfill({
          status: response.status, contentType: "application/json",
          headers: { "cache-control": response.headers.get("cache-control")! },
          body: await response.text(),
        });
      }
      const layoutReads: Record<string, unknown> = {
        "/api/users/me": { id: 1, membershipTier: "Free" },
        "/api/member-stories/removal-alerts": [],
        "/api/membership/review-notifications": [],
        "/api/membership/invoice-history-notice": { overdueCount: 1, failedAttemptThreshold: 8 },
      };
      if (!(path in layoutReads)) {
        unexpected.push(`${request.method()} ${path}`);
        return route.abort();
      }
      return route.fulfill({ json: layoutReads[path] });
    });
    await page.clock.install();
    await page.goto(`${webBase}/tests/invoice-history-harness.html`);
    await page.waitForLoadState("networkidle");
    const recoveredRow = page.getByTestId("row-checkout-1");
    await browserExpect(recoveredRow).toContainText(ended);
    await browserExpect(page.getByTestId("row-checkout-2")).toContainText(waiting);
    await browserExpect(page.getByTestId("row-checkout-3")).toHaveCount(0);
    await browserExpect(page.getByTestId("history-fetching")).toHaveText("0");
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    expect(await snapshot()).toEqual(before); // Staff reads never mutate anything.

    const list = vi.fn(async (params: { subscription: string }) => {
      expect(params.subscription).toBe(subscription);
      return { data: ["2026-09-01", "2026-08-01", "2026-07-01"].map((date, i) => ({
        id: `in_owned_${i}_${run}`, created: Date.parse(date) / 1000,
        billing_reason: "subscription_cycle", status: "open", attempt_count: 1,
      })), has_more: false };
    });
    const forbidden = vi.fn(() => { throw new Error("History recovery must not retrieve or mutate a subscription"); });
    const stripe = { invoices: { list }, subscriptions: { retrieve: forbidden, cancel: forbidden, update: forbidden } } as unknown as Stripe;
    // Run the actual scheduled-review selection and transaction path, scoped
    // to our subscription. Only resource acquisition is isolated; every SQL
    // statement (including eligibility, row lock, update, and commit) is real.
    const sweepClient = {
      query: client.query.bind(client), release: vi.fn(),
    } as unknown as PoolClient;
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation(
      (async () => sweepClient) as typeof pool.connect,
    );
    vi.mocked(getUncachableStripeClient).mockResolvedValueOnce(stripe);
    try {
      await reconcileMemberships(subscription);
    } finally {
      connectSpy.mockRestore();
    }
    expect(list).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
    const after = await snapshot();
    expect(after[0]).toEqual({
      ...before[0], status: "forfeited", membership_tier: "Free",
      failed_months: 3, last_failed_invoice: `in_owned_0_${run}`,
      invoice_history_pending: false, invoice_history_retry_count: 0, invoice_history_retry_at: null,
    });
    expect(after.slice(1)).toEqual(before.slice(1));
    expect((await queue()).memberships.map(row => row.checkoutId)).toEqual([2]);
    // The page stays mounted and stale until ITS freshness path runs.
    await browserExpect(recoveredRow).toHaveCount(1);
    const readsBeforeRefresh = reads;
    if (refresh === "interval") await page.clock.runFor(60000);
    else {
      await page.evaluate(`(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        window.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        window.dispatchEvent(new Event("visibilitychange"));
      })()`);
      await page.clock.runFor(1);
    }
    await browserExpect.poll(() => reads).toBeGreaterThan(readsBeforeRefresh);
    // Fetch resolves on the real network; React Query batches the subsequent
    // render on a timer. Let that notification run on the paused browser clock.
    await page.waitForTimeout(100);
    await page.clock.runFor(1);
    await browserExpect(recoveredRow).toHaveCount(0);
    try {
      await browserExpect(page.getByTestId("row-checkout-2")).toContainText(waiting);
    } catch (error) {
      throw new Error(`${String(error)}\nBrowser: ${await page.locator("body").innerText()}\nErrors: ${JSON.stringify(errors)}\nRequests: ${JSON.stringify(unexpected)}\nVite: ${viteOutput}`);
    }
    await browserExpect(page.getByTestId("history-fetching")).toHaveText("0");
    expect(page.url()).toBe(`${webBase}/tests/invoice-history-harness.html`);
    expect(await snapshot()).toEqual(after);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    try { await context?.close(); }
    finally {
      try {
        if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      } finally {
        querySpy?.mockRestore();
        // Destroy the connection rather than returning temp tables to the pool.
        client.release(true);
        identity.staff = "";
      }
    }
  }
}, 60000);