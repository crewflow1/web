import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for INTEGRATION tests (OQ-16 — "a real Postgres in CI").
 *
 * Unlike the unit config (vitest.config.ts), these tests run against a
 * REAL database: the Supabase local stack in CI (`supabase start`), or any
 * disposable Supabase you point the env at locally. They exercise the
 * actual supabase/migrations and assert real RLS / auth behaviour that
 * mocked unit tests structurally cannot.
 *
 * With no database configured the suite self-skips locally and fails loudly
 * in CI — see __tests__/integration/_harness.ts → describeIntegration.
 */
export default defineConfig({
  // Use the automatic JSX runtime (matches Next AND vitest.config.ts) so
  // react-pdf templates render in-process without a manual React import — the
  // classic runtime would throw "React is not defined" inside the .tsx PDF
  // components (they import no React, exactly like in prod). Needed here because
  // integration tests can drive real render paths (e.g. the portal bulk
  // download) end to end against Postgres.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["__tests__/integration/**/*.test.ts"],
    globals: false,
    pool: "forks",
    // One shared Postgres → run files serially so fixtures can't race.
    fileParallelism: false,
    setupFiles: ["__tests__/integration/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
