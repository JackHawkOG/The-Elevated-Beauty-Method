import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Isolated test server: replaces only Clerk; the page and generated API hooks are real.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@clerk/react": path.resolve(import.meta.dirname, "tests/mock-clerk.ts"),
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: { entries: ["tests/audit-harness.html", "tests/membership-harness.html"] },
  server: { host: "127.0.0.1", strictPort: true },
});