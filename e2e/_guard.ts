import { assertLocalDestructiveTarget } from "../lib/testing/destructive-db-guard";

/**
 * E2E destructive-target guard.
 *
 * The Playwright tier seeds organisations, users, jobs, blueprints, RAMS and
 * storage objects with the SERVICE-ROLE key (RLS bypassed) and deletes them
 * again. It resolves its database from `NEXT_PUBLIC_SUPABASE_URL` — note this
 * is a DIFFERENT variable from the integration harness (which prefers the bare
 * `SUPABASE_URL`), so the guard is told the real name here rather than guessing.
 *
 * Two layers, both required:
 *
 *   1. `e2e/global-setup.ts` calls this first, before its own `createClient`.
 *      Playwright aborts the entire run if globalSetup throws, so one refusal
 *      there stops every spec in the process.
 *   2. Each spec that builds its own service-role client calls it too. Layer 1
 *      is process-wide but lives in one file; layer 2 means a spec cannot reach
 *      a non-local database even if it is ever run through a different config.
 *
 * Policy, redaction and the (deliberate) absence of an override all live in
 * lib/testing/destructive-db-guard.ts — this is only the call site.
 *
 * Imported by relative path, not the "@/" alias, so it resolves identically
 * under Playwright's loader and `tsc`.
 */

/** Refuses unless NEXT_PUBLIC_SUPABASE_URL names a local database. */
export function assertLocalE2eTarget(entryPoint: string): string {
  return assertLocalDestructiveTarget(process.env.NEXT_PUBLIC_SUPABASE_URL, {
    entryPoint: `e2e ${entryPoint}`,
    envVar: "NEXT_PUBLIC_SUPABASE_URL",
  });
}
