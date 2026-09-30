import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror the "@/*" -> "./*" path alias from tsconfig.json so the
// kernel test suite resolves the same module specifiers as the app.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
