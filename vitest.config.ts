import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror the "@/*" -> "./*" path alias from tsconfig.json so the
// kernel test suite resolves the same module specifiers as the app.
export default defineConfig({
  test: {
    // shared-context-mcp is a separate package with its own suite; keep it out
    // of the app's runs so `npm test` reports the product honestly.
    exclude: ["node_modules/**", "shared-context-mcp/**", ".next/**"],
    // Phase 3 persistence tests talk to a real database. They self-skip when
    // DATABASE_URL is absent, which keeps `npm test` usable on a machine with
    // no Postgres while never reporting evidence that was not gathered.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
