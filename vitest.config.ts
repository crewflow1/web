import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config — unit tests only. Fast and dependency-free: mocked
 * Supabase clients, no DB, no network. Deterministic in-process PDF template
 * rendering (react-pdf renderToBuffer) IS allowed — it's pure Node, no I/O.
 *
 * Two tiers run via their own configs and are EXCLUDED here so each CI gate
 * owns exactly one tier (a failure is attributed to the right gate, never
 * buried in the unit run):
 *   - Integration (__tests__/integration/**) — needs a real Postgres;
 *     `npm run test:integration` (vitest.integration.config.ts).
 *   - Security    (__tests__/security/**)    — trust-boundary proofs;
 *     `npm run test:security` (vitest.security.config.ts).
 */
export default defineConfig({
  // Use the automatic JSX runtime (matches Next) so react-pdf templates render
  // in-process without a manual React import — the classic runtime would throw
  // "React is not defined".
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "__tests__/integration/**",
      "__tests__/security/**",
    ],
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
