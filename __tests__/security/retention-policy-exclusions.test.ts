import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RETENTION_PURGEABLE_TABLES,
  RETENTION_EXCLUDED_TABLES,
  isExcluded,
  isPurgeable,
  assertRetentionSetsDisjoint,
} from "@/lib/retention/policy";
import { ERASE_ANONYMISE_TABLES } from "@/lib/gdpr/erase-tables";

/**
 * DATA RETENTION — THE EXCLUSION GUARD (hermetic; list algebra + filesystem).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HARD RULE: a statutory / financial / audit table can NEVER be purgeable.
 * ═════════════════════════════════════════════════════════════════════════════
 * This is the single most important test for the retention system. If any edit
 * ever moved an excluded table onto the purge allowlist — in the TS registry,
 * the DB CHECK, or the SQL primitive's internal allowlist — one of these
 * assertions fails and the build goes red. The three allowlist copies are also
 * pinned byte-identical here so they can never silently drift apart.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIG = resolve(
  ROOT,
  "supabase/migrations/20261184000000_retention_policies.sql",
);
const sql = readFileSync(MIG, "utf8");

/** Strip SQL line comments so we test executable statements, not prose. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const code = sqlOnly(sql);

/** Tables named in the `target_table in ( ... )` CHECK on retention_policies. */
function checkAllowlist(): string[] {
  const m = code.match(/table_name\s+in\s*\(([^)]*)\)/i);
  expect(m, "retention_policies target_table CHECK not found").not.toBeNull();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
}

/** Tables named in the primitive's internal c_allow VALUES array. */
function primitiveAllowlist(): string[] {
  const m = code.match(/c_allow\s+constant\s+text\[\]\[\]\s*:=\s*array\[([\s\S]*?)\];/i);
  expect(m, "retention_purge_run c_allow array not found").not.toBeNull();
  // Each row is ['table', 'ts_col'] — take the FIRST literal per row (the table).
  const rows = [...m![1]!.matchAll(/\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g)];
  return rows.map((r) => r[1]!).sort();
}

// ---------------------------------------------------------------------------
// 1. THE CRITICAL INVARIANT — excluded ∩ purgeable = ∅
// ---------------------------------------------------------------------------
describe("no protected table is ever purgeable", () => {
  it("the purgeable and excluded sets are disjoint (TS)", () => {
    const overlap = RETENTION_PURGEABLE_TABLES.filter((t) => isExcluded(t));
    expect(overlap, `these tables are BOTH purgeable and excluded: ${overlap.join(", ")}`).toEqual([]);
    // The runtime fail-closed guard must agree (it throws on overlap).
    expect(() => assertRetentionSetsDisjoint()).not.toThrow();
  });

  it("every hard-coded excluded table is refused by isPurgeable", () => {
    for (const t of RETENTION_EXCLUDED_TABLES) {
      expect(isPurgeable(t), `${t} is excluded but reported purgeable`).toBe(false);
    }
  });

  it("the specific financial/audit domains the directive names are all excluded", () => {
    // If someone deletes one of these from RETENTION_EXCLUDED, this fails.
    for (const t of [
      "invoices",
      "invoice_payments",
      "finances",
      "quotes",
      "quote_versions",
      "payments",
      "purchase_orders",
      "bank_statements",
      "supplier_payments",
      "payroll_runs",
      "payroll_lines",
      "pension_enrolments",
      "cis_subcontractors",
      "cis_statements",
      "cis_monthly_returns",
      "hmrc_submissions",
      "activity_log",
      "hq_events",
      "gdpr_export_log",
      "gdpr_erasure_log",
      "retention_purge_log",
    ]) {
      expect(isExcluded(t), `${t} must be excluded`).toBe(true);
      expect(isPurgeable(t), `${t} must NOT be purgeable`).toBe(false);
    }
  });

  it("the exclusion set is a SUPERSET of the GDPR statutory-retention set", () => {
    // Every table the GDPR classification anonymises (rather than deletes)
    // because it is a statutory record MUST also be un-purgeable here. This ties
    // the retention exclusion to the already-reasoned statutory census, so a NEW
    // statutory table added to GDPR forces a matching exclusion here.
    for (const t of ERASE_ANONYMISE_TABLES) {
      expect(isExcluded(t), `GDPR-statutory ${t} must be in the retention exclusion set`).toBe(true);
      expect(isPurgeable(t), `GDPR-statutory ${t} must NOT be purgeable`).toBe(false);
    }
  });

  it("the guarantee is not vacuous", () => {
    expect(RETENTION_PURGEABLE_TABLES.length).toBeGreaterThanOrEqual(5);
    expect(RETENTION_EXCLUDED_TABLES.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 2. THREE ALLOWLIST COPIES STAY IDENTICAL (drift guard)
// ---------------------------------------------------------------------------
describe("the purge allowlist is identical in TS, the CHECK, and the primitive", () => {
  it("TS RETENTION_PURGEABLE_TABLES === retention_policies CHECK values", () => {
    expect(checkAllowlist()).toEqual([...RETENTION_PURGEABLE_TABLES]);
  });

  it("TS RETENTION_PURGEABLE_TABLES === retention_purge_run c_allow tables", () => {
    expect(primitiveAllowlist()).toEqual([...RETENTION_PURGEABLE_TABLES]);
  });

  it("no excluded table appears in the DB CHECK or the primitive allowlist", () => {
    for (const t of [...checkAllowlist(), ...primitiveAllowlist()]) {
      expect(isExcluded(t), `${t} is on a DB allowlist but is an excluded table`).toBe(false);
    }
  });
});
