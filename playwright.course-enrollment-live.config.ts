import { defineConfig } from "@playwright/test";
import auditLiveConfig from "./playwright.audit-live.config";

// Real Clerk and the running API; never the mock-Clerk harness.
export default defineConfig({
  ...auditLiveConfig,
  testMatch: "course-enrollment-live.spec.ts",
});