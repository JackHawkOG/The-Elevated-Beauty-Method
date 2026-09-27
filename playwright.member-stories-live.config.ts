import { defineConfig } from "@playwright/test";
import auditLiveConfig from "./playwright.audit-live.config";

export default defineConfig({
  ...auditLiveConfig,
  testMatch: "member-stories-live.spec.ts",
});