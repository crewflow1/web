import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config — unit tests only. Fast and dependency-free: mocked
 * Supabase clients, no DB, no network, no PDF rendering.
 *
 * Integration tests (__tests__/integration/**) are EXCLUDED here — they
 * need a real Postgres and run via their own config:
 * `npm run test:integration` (see vitest.integration.config.ts).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "__tests__/integration/**"],
    globals: false,
    pool: "forks",
    setupFiles: ["__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
