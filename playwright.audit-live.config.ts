import { defineConfig } from "@playwright/test";

// This suite uses the running development workflows and real Clerk sessions.
// It must never use the isolated mock-Clerk Vite server from playwright.config.ts.
export default defineConfig({
  testDir: "artifacts/edu-portal/tests",
  testMatch: "radiant-audit-live.spec.ts",
  workers: 1,
  retries: 0,
  use: {
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    baseURL: process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://localhost:80",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
});