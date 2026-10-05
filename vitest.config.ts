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
    // When DATABASE_URL is set, the suite is running against ONE real Postgres
    // database that every worker shares. Parallel files then truncate each
    // other's tables mid-test and deadlock on the same locks, which shows up as
    // flaky, order-dependent failures rather than as an infrastructure error.
    //
    // So: no database -> parallelism is free and stays on. Database -> serialise.
    // The DB-backed tests self-skip when DATABASE_URL is absent, so the default
    // `npm test` behaviour is unchanged on a machine with no Postgres.
    fileParallelism: !process.env.DATABASE_URL,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
