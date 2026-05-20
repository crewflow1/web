import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config — first test slice.
 *
 * Keeps tests fast and dependency-free: unit tests with mocked Supabase
 * clients only. No DB, no network, no PDF rendering inside the tests
 * (we mock the email-send helper too).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
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
