import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "artifacts/edu-portal/tests",
  testMatch: "*.spec.ts",
  testIgnore: ["radiant-audit-live.spec.ts", "community-live.spec.ts"],
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "pnpm --filter @workspace/edu-portal exec vite --config vite.audit-test.config.ts --port 4179",
    url: "http://127.0.0.1:4179/tests/audit-harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});