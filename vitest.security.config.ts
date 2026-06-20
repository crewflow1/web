import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for the SECURITY VALIDATION tier (Directive #004 — gate 5 of
 * the mandatory six-gate pipeline).
 *
 * These are the trust-boundary proofs in __tests__/security: tenant isolation
 * on the service-role (RLS-bypass) path, cron Bearer gates, portal-upload
 * safety, the Report-Only CSP + baseline security headers, rate-limit
 * behaviour, role-escalation prevention, customer-portal scoping, and the
 * "no secret env in client bundles" pins.
 *
 * They are HERMETIC by design — filesystem scans + pure functions + mocked
 * Supabase clients — so they need no database and run fast on Node 20. The
 * live-DB security proofs (real RLS denial against Postgres) live in the
 * integration tier instead; see vitest.integration.config.ts.
 *
 * Run via `npm run test:security`. This tier is EXCLUDED from the unit config
 * (vitest.config.ts) so each gate owns its own tier — a security regression
 * surfaces as a SECURITY failure, never buried inside the unit run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/security/**/*.test.ts"],
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
