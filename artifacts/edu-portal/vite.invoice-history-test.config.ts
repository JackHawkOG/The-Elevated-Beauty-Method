import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Keep both the managed preview and other browser suites' optimizer state out
// of this integrated check. Only this harness is prebundled.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "node_modules/.vite-invoice-history-test",
  plugins: [react()],
  resolve: {
    alias: {
      "@clerk/react": path.resolve(import.meta.dirname, "tests/mock-clerk.ts"),
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: { entries: ["tests/invoice-history-harness.html"] },
  server: { host: "127.0.0.1", strictPort: true },
});