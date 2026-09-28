import { defineConfig } from "@playwright/test";
import auditLiveConfig from "./playwright.audit-live.config";

// Share the real development preview and Clerk setup, but run only this suite.
export default defineConfig({
  ...auditLiveConfig,
  testMatch: ["community-live.spec.ts", "announcement-links-live.spec.ts"],
});