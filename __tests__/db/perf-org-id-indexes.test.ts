import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Schema-assertion suite for the pre-launch org_id index migration
 * (Phase 1 performance hardening). CI has no database — exactly like
 * billing-schema-protections.test.ts asserts on the migration SQL itself —
 * so these lock the indexes in place and guarantee the migration stays
 * additive + idempotent: a future edit can't silently drop an index or
 * smuggle a behavioural (schema / data / RLS) change into what is meant to
 * be an index-only migration.
 *
 * The five org_id indexes:
 *   - import_rows(org_id), import_files(org_id)  — read by the HQ onboarding
 *     snapshot's `.in("org_id", ids)` fan-out; both tables grow with every
 *     import across every org.
 *   - import_audit(org_id), quote_line_items(org_id), payroll_lines(org_id)
 *     — support the org_id RLS predicate + Phase-5 org-scoped cleanup deletes
 *     on tables that have no org_id index today.
 */

const root = resolve(__dirname, "../..");
const raw = readFileSync(
  resolve(root, "supabase/migrations/20260711000000_perf_org_id_indexes.sql"),
  "utf-8",
);
// Assert on executable SQL only — strip line comments so the explanatory
// header (which mentions "CREATE INDEX") can't skew statement counts.
const sql = raw.replace(/--.*$/gm, "");

const TABLES = [
  "import_rows",
  "import_files",
  "import_audit",
  "quote_line_items",
  "payroll_lines",
] as const;

describe("perf org_id indexes — every target table gets an org_id btree index", () => {
  for (const tbl of TABLES) {
    it(`creates ${tbl}_org_id_idx on public.${tbl} (org_id)`, () => {
      const re = new RegExp(
        `create\\s+index\\s+if\\s+not\\s+exists\\s+${tbl}_org_id_idx\\s+on\\s+public\\.${tbl}\\s*\\(\\s*org_id\\s*\\)`,
        "i",
      );
      expect(sql).toMatch(re);
    });
  }
});

describe("perf org_id indexes — idempotent + additive only", () => {
  it("guards every CREATE INDEX with IF NOT EXISTS and adds exactly five", () => {
    const creates = sql.match(/create\s+index/gi) ?? [];
    const guarded = sql.match(/create\s+index\s+if\s+not\s+exists/gi) ?? [];
    expect(creates).toHaveLength(TABLES.length);
    expect(guarded).toHaveLength(TABLES.length);
  });

  it("is purely additive — no destructive or behavioural statements", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/\balter\s+table\b/i);
    expect(sql).not.toMatch(/\bcreate\s+policy\b/i);
    expect(sql).not.toMatch(/\bdrop\s+policy\b/i);
    // The rollback statements must stay commented out (executable SQL only).
    expect(sql).not.toMatch(/\bdrop\s+index\b/i);
  });
});
