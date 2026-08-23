import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WAVE A.3 GUARD — generated Supabase types must not silently drift stale.
 *
 * The defect this pins: `lib/supabase/types.ts` had drifted to 45 of ~315 tables
 * (~14% coverage) because there was no sanctioned regen script and no CI check,
 * so ~85% of the schema had no compile-time contract. This guard is deterministic
 * (pure filesystem — no DB, no supabase CLI, no version-sensitive byte-diff, so it
 * can never go flaky) and catches the exact regression class: a whole era of the
 * schema vanishing from the generated types.
 *
 * Regenerate with the sanctioned command when the schema changes:
 *   npm run db:types      (== supabase gen types typescript --linked > lib/supabase/types.ts)
 *
 * It does NOT assert column-level parity (that needs a live schema); it asserts
 * (a) a floor on total table coverage, and (b) presence of representative tables
 * spanning every era of the product, so a revert to the stale snapshot fails loud.
 */

const TYPES = readFileSync(
  resolve(__dirname, "..", "..", "lib/supabase/types.ts"),
  "utf8",
);

/** Count `Row: {` blocks — one per table/view in the generated `Tables`/`Views`. */
const rowBlocks = (TYPES.match(/\bRow:\s*\{/g) ?? []).length;

/**
 * Representative tables that MUST have a generated contract. Chosen to span the
 * schema eras AFTER the stale 45-table snapshot (which pre-dated stock, HQ/AI,
 * CIS, H&S, telephony, SSO, retention, etc.). If types.ts reverts to the stale
 * shape, the post-45 rows below vanish and this fails.
 */
const REQUIRED_TABLES = [
  // early era (were present even when stale)
  "jobs",
  "invoices",
  "customers",
  "quotes",
  // stock / operations era
  "stock_movements",
  "supplier_payments",
  "material_requests",
  // HQ / AI-workforce era
  "hq_ai_tasks",
  "hq_decisions",
  "hq_workflow_sagas",
  // finance / statutory era
  "cis_statements",
  "job_valuations",
  // H&S / site era
  "toolbox_talks",
  "worker_signoff_tokens",
  // platform / integrations era
  "phone_numbers",
  "cron_runs",
  "demo_requests",
] as const;

describe("supabase generated types — coverage guard (Wave A.3)", () => {
  it("declares a Row contract for far more than the stale 45-table snapshot", () => {
    // The authoritative schema generates ~315 blocks. A floor of 250 is well
    // above the stale 45 and comfortably below the real count, so it fails on a
    // regression without being brittle to a handful of new/dropped tables.
    expect(rowBlocks).toBeGreaterThan(250);
  });

  it("includes representative tables from every schema era", () => {
    const missing = REQUIRED_TABLES.filter(
      (t) => !new RegExp(`\\n {6}${t}:\\s*\\{`).test(TYPES),
    );
    expect(
      missing,
      `lib/supabase/types.ts is missing generated contracts for: ${missing.join(", ")}. ` +
        `Regenerate with \`npm run db:types\`.`,
    ).toEqual([]);
  });
});
