import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror the "@/*" -> "./*" path alias from tsconfig.json so the
// kernel test suite resolves the same module specifiers as the app.
export default defineConfig({
  test: {
    // shared-context-mcp is a separate package with its own suite; keep it out
    // of the app's kernel run so `npm test` reports the kernel honestly.
    exclude: ["node_modules/**", "shared-context-mcp/**", ".next/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
