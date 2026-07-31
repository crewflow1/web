/**
 * Integration-test harness (OQ-16).
 *
 * Builds Supabase clients against a REAL Postgres and decides whether the
 * integration suite runs at all:
 *
 *   serviceClient() — service_role, BYPASSES RLS. Fixture setup/teardown
 *                     and ground-truth assertions.
 *   anonClient()    — anon role, SUBJECT TO RLS. Prove unauthenticated
 *                     callers are denied tenant data.
 *   userClient(jwt) — a signed-in user (authenticated role). Prove tenant
 *                     isolation between organisations.
 *
 * Connection details are read from the environment (both NEXT_PUBLIC_* and
 * bare names are accepted). In CI they come from `supabase start`.
 *
 * Gating (describeIntegration):
 *   - live DB        → suite runs.
 *   - no DB, not CI  → suite skipped (local convenience).
 *   - no DB, in CI   → a failing test, so a misconfigured CI run can never
 *                      go green by silently skipping (IMPLEMENTATION-RULES).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, test } from "vitest";
import type { Database } from "@/lib/supabase/types";
import { assertLocalDestructiveTarget } from "@/lib/testing/destructive-db-guard";
import { formatDayKeyUK } from "@/lib/time/format";

type Conn = { url: string; anonKey: string; serviceRoleKey: string };

/**
 * Names the guard reports, in the exact precedence readConn() resolves them.
 * Kept beside readConn so the message can never drift from what is actually read.
 */
const TARGET_ENV = "SUPABASE_URL (else NEXT_PUBLIC_SUPABASE_URL)";

function readConn(): Partial<Conn> {
  return {
    url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** True when a real database is fully configured. */
export function hasLiveDb(): boolean {
  const c = readConn();
  return Boolean(c.url && c.anonKey && c.serviceRoleKey);
}

function conn(): Conn {
  const c = readConn();
  if (!c.url || !c.anonKey || !c.serviceRoleKey) {
    throw new Error(
      "Integration harness: missing SUPABASE_URL / SUPABASE_ANON_KEY / " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `supabase start` or point these at " +
        "a disposable database.",
    );
  }
  /**
   * STRUCTURAL CHOKEPOINT. Every client this harness hands out — service_role
   * (RLS-bypassing, used for fixture setup and teardown), anon, and user — is
   * built from this one function, and all 150+ integration files go through it.
   * Guarding here means no integration test can obtain a client pointed at a
   * non-local database, and the check runs BEFORE createClient, never after the
   * first write. `c.url` is the identical value passed to createClient below.
   */
  assertLocalDestructiveTarget(c.url, {
    entryPoint: "integration test harness (__tests__/integration/_harness.ts)",
    envVar: TARGET_ENV,
  });
  return c as Conn;
}

const NO_PERSIST = { auth: { autoRefreshToken: false, persistSession: false } } as const;

/** service_role client — bypasses RLS. */
export function serviceClient(): SupabaseClient<Database> {
  const { url, serviceRoleKey } = conn();
  return createClient<Database>(url, serviceRoleKey, NO_PERSIST);
}

/** anon client — subject to RLS. */
export function anonClient(): SupabaseClient<Database> {
  const { url, anonKey } = conn();
  return createClient<Database>(url, anonKey, NO_PERSIST);
}

/** authenticated client bound to a user access token — subject to RLS. */
export function userClient(accessToken: string): SupabaseClient<Database> {
  const { url, anonKey } = conn();
  return createClient<Database>(url, anonKey, {
    ...NO_PERSIST,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * TODAY in **Europe/London**, as `YYYY-MM-DD` — the probe date to hand any RPC
 * that buckets by the UK calendar.
 *
 * WHY THIS EXISTS, AND WHAT IT COST TO LEARN IT.
 *
 * Several rollups (`ai_invocations_month_totals`, `ai_reservations_month_totals`
 * and the per-feature rollup beside them) take a date and derive the
 * **Europe/London** month around it:
 *
 *     where created_at >= (date_trunc('month', p_month) at time zone 'Europe/London')
 *       and created_at <  (… + interval '1 month'      at time zone 'Europe/London')
 *
 * A test that reaches for `new Date().toISOString().slice(0, 10)` passes the
 * **UTC** calendar date instead. In GMT the two agree, so the mistake is
 * invisible for half the year. In BST they disagree between 23:00 and 24:00 UTC
 * — and on the LAST DAY OF A MONTH they disagree by a whole month. At 23:07 UTC
 * on 31 July 2026 the UTC date is still `2026-07-31`, so the window resolves to
 * `[2026-06-30 23:00Z, 2026-07-31 23:00Z)` while every row the test has just
 * written carries `created_at = now()` = `23:07Z` — seven minutes PAST the end
 * of the window it is being counted in. The rollup returns no rows at all, and
 * the suite reports every figure as 0 or undefined.
 *
 * That is exactly how main went red: CI at 22:31 UTC was green, CI at 23:05 UTC
 * failed 17 assertions across two files, and the six commits in between never
 * touched the AI ledger. Deriving the probe date here, from the same UK day-key
 * idiom the production governor uses (`ukMonthKeyOf` → `formatDayKeyUK`), makes
 * the month a test asks for the month the SQL is actually in.
 *
 * NOT a substitute for pinning: a suite that asserts a SPECIFIC boundary must
 * still write explicit `created_at` values (see the BST/GMT boundary cases in
 * `rls/ai-invocations.test.ts`), because those must hold in every month, not
 * only the current one.
 */
export function ukTodayIso(): string {
  return formatDayKeyUK(new Date());
}

/** describe() that runs only against a live database (see file header). */
export function describeIntegration(name: string, fn: () => void): void {
  if (hasLiveDb()) {
    describe(name, fn);
    return;
  }
  if (process.env.CI) {
    describe(name, () => {
      test("requires a live database in CI", () => {
        throw new Error(
          "Integration tests need a Postgres database, but none was " +
            "configured. Did `supabase start` run before this suite?",
        );
      });
    });
    return;
  }
  describe.skip(name, fn);
}
