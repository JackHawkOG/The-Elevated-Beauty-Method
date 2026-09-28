import { defineConfig } from "@playwright/test";
import auditLiveConfig from "./playwright.audit-live.config";

export default defineConfig({
  ...auditLiveConfig,
  testMatch: "announcement-activity-review-live.spec.ts",
});