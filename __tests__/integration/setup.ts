/**
 * Vitest setup for INTEGRATION tests.
 *
 * Deliberately does NOT inject fake Supabase credentials the way the unit
 * setup (__tests__/setup.ts) does. Integration tests need REAL connection
 * details from the environment:
 *
 *   SUPABASE_URL              (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_ANON_KEY         (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * In CI these are exported from `supabase start`. Locally, if they are
 * absent the harness skips every integration test (see _harness.ts).
 */
import { vi } from "vitest";
import { assertLocalDestructiveTargetIfConfigured } from "@/lib/testing/destructive-db-guard";

/**
 * EARLIEST possible gate for this tier.
 *
 * vitest runs setupFiles once per worker BEFORE it imports a single test file,
 * so refusing here aborts the whole run before any fixture, any truncation, and
 * any `createClient` — rather than surfacing as one failed test after the first
 * destructive write has already landed. `_harness.ts` guards the same target
 * again at the point of client construction; this is the early, loud one.
 *
 * Resolution order is IDENTICAL to _harness.ts readConn(): a guard that checks
 * a different variable than the code uses proves nothing.
 *
 * Silent when nothing is configured — "no database" is the tier's own decision
 * (skip locally, fail loudly in CI, see describeIntegration), not this guard's.
 */
assertLocalDestructiveTargetIfConfigured(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  {
    entryPoint: "integration test tier (vitest.integration.config.ts setup)",
    envVar: "SUPABASE_URL (else NEXT_PUBLIC_SUPABASE_URL)",
  },
);

// Let integration tests import server-only app modules without the
// "server-only" import guard throwing inside the Node test runner.
vi.mock("server-only", () => ({}));
