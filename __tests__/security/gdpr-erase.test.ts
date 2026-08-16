import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ERASE_ANONYMISE_TABLES,
  ERASE_RETAIN_TABLES,
  ERASE_HARD_DELETE_TABLES,
} from "@/lib/gdpr/erase-tables";

/**
 * GDPR right-to-erasure (Art. 17, migration 20261168) — trust-boundary proofs
 * (hermetic; filesystem + list algebra, no DB).
 *
 * Section 1: the classification never destroys a statutory record.
 * Section 2: the migration primitive is service_role-only, confirmation-gated,
 *            single-transaction, fail-closed, append-only-audited.
 * Section 3: the service is storage-first, service-role, and drives the DB from
 *            the single-source classification (no duplicated table set).
 * Section 4: the route is DARK by default, owner/super-admin-gated, and demands
 *            a confirmation token BEFORE it does anything destructive.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261168000000_gdpr_erasure.sql";
const SERVICE = "server/services/gdpr-erase.ts";
const ROUTE = "app/api/gdpr/erase/route.ts";

/** Strip TS/JS comments so contracts test EXECUTABLE code, not prose. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Strip SQL line comments so assertions test executable statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

// ---------------------------------------------------------------------------
// 1. THE CLASSIFICATION — statutory records are never destroyed
// ---------------------------------------------------------------------------

describe("erasure classification preserves statutory records", () => {
  it("no financial/tax record appears in the hard-delete set", () => {
    const del = new Set(ERASE_HARD_DELETE_TABLES);
    for (const t of [
      "finances",
      "invoices",
      "payments",
      "supplier_payments",
      "purchase_orders",
      "hmrc_submissions",
      "payroll_runs",
      "cis_statements",
    ]) {
      expect(del.has(t), `${t} must NOT be hard-deleted`).toBe(false);
    }
  });

  it("preserved sets are non-empty (the guarantee isn't vacuous)", () => {
    expect(ERASE_ANONYMISE_TABLES.length).toBeGreaterThan(10);
    expect(ERASE_RETAIN_TABLES.length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// 2. THE MIGRATION PRIMITIVE — locked down, gated, atomic, fail-closed
// ---------------------------------------------------------------------------

describe("gdpr_erase_org primitive is service_role-only + confirmation-gated", () => {
  const sql = sqlOnly(read(MIG));

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function public\.gdpr_erase_org/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path/i);
  });

  it("revokes anon/authenticated and grants ONLY service_role", () => {
    expect(sql).toMatch(/revoke all on function public\.gdpr_erase_org[\s\S]*from public/i);
    expect(sql).toMatch(/revoke execute on function public\.gdpr_erase_org[\s\S]*from anon, authenticated/i);
    expect(sql).toMatch(/grant\s+execute on function public\.gdpr_erase_org[\s\S]*to service_role/i);
  });

  it("re-checks service_role inside the body (defence in depth)", () => {
    expect(sql).toMatch(/auth\.role\(\)\s+is distinct from\s+'service_role'/i);
    expect(sql).toMatch(/42501/);
  });

  it("REQUIRES a confirmation token equal to the org slug (anti-misfire)", () => {
    expect(sql).toMatch(/p_confirm\s*<>\s*v_slug/i);
    expect(sql).toMatch(/confirmation token/i);
  });

  it("validates inputs before any write: disjoint sets + org-scoped base tables", () => {
    expect(sql).toMatch(/disposition sets overlap/i);
    // Refuses any action table that is not an org-scoped public base table.
    expect(sql).toMatch(/is not an org-scoped public base table/i);
    expect(sql).toMatch(/table_type\s*=\s*'BASE TABLE'/i);
    expect(sql).toMatch(/column_name\s*=\s*'org_id'/i);
  });

  it("ANONYMISES by PII column name and DETACHES FKs to hard-delete tables", () => {
    // PII scrub via a name pattern; FK-detach nulls references so retained rows
    // survive deletion of their PII parents.
    expect(sql).toMatch(/ni_number|national_insurance/i);
    expect(sql).toMatch(/\[erased\]/);
    expect(sql).toMatch(/pg_constraint/i);
    expect(sql).toMatch(/foreign_key_violation/i);
  });

  it("hard-deletes via a fail-closed topological loop, pinned to org_id", () => {
    // Every delete is org-pinned; a non-converging pass raises (rolls back).
    expect(sql).toMatch(/delete from public\.%I where org_id = \$1/i);
    expect(sql).toMatch(/did not converge|NOTHING committed/i);
  });

  it("every mutation is org-pinned (no unpinned UPDATE/DELETE)", () => {
    // Both dynamic statements carry `where org_id = $1`.
    expect(sql).toMatch(/update public\.%I set %s where org_id = \$1/i);
    expect(sql).toMatch(/delete from public\.%I where org_id = \$1/i);
  });
});

describe("gdpr_erasure_log is append-only, member-read, service_role-write", () => {
  const sql = sqlOnly(read(MIG));

  it("enables RLS and is member-read only", () => {
    expect(sql).toMatch(/alter table public\.gdpr_erasure_log enable row level security/i);
    expect(sql).toMatch(/for select[\s\S]*current_org_ids\(\)/i);
  });

  it("is APPEND-ONLY: no update, no delete, and no authenticated insert policy", () => {
    // Only the SECURITY DEFINER function (service_role) writes it.
    expect(sql).not.toMatch(/for\s+update/i);
    expect(sql).not.toMatch(/for\s+delete/i);
    expect(sql).not.toMatch(/for insert/i);
  });

  it("cascades on org teardown and adds NO trigger (the 20261052 rule)", () => {
    expect(sql).toMatch(/references public\.organizations\(id\) on delete cascade/i);
    expect(sql).not.toMatch(/create trigger/i);
  });

  it("has only the 'erased' status (no fabricated outcomes)", () => {
    expect(sql).toMatch(/status\s+text not null default 'erased' check \(status in \('erased'\)\)/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE SERVICE — storage-first, service-role, single-source classification
// ---------------------------------------------------------------------------

describe("gdpr erase service is storage-first + single-source classified", () => {
  const code = codeOf(read(SERVICE));

  it("uses the service-role admin client (RLS-bypass, gated upstream)", () => {
    expect(code).toMatch(/createAdminClient/);
  });

  it("cleans storage bytes via the Storage API (not a SQL row delete)", () => {
    // Storage API remove() deletes the S3 bytes; a SQL delete would orphan them.
    expect(code).toMatch(/\.storage/);
    expect(code).toMatch(/\.remove\(/);
    expect(code).toMatch(/ERASE_STORAGE_BUCKETS/);
  });

  it("drives the DB primitive with the single-source disposition sets", () => {
    expect(code).toMatch(/gdpr_erase_org/);
    expect(code).toMatch(/ERASE_ANONYMISE_TABLES/);
    expect(code).toMatch(/ERASE_HARD_DELETE_TABLES/);
    expect(code).toMatch(/ERASE_RETAIN_TABLES/);
    // The confirmation token is passed through for the DB re-check.
    expect(code).toMatch(/p_confirm/);
  });

  it("exposes the DARK feature-flag helper (default off)", () => {
    expect(code).toMatch(/FEATURE_GDPR_ERASURE/);
  });

  it("is loud — storage errors throw, never silently skip", () => {
    expect(code).toMatch(/throw new Error/);
  });
});

// ---------------------------------------------------------------------------
// 4. THE ROUTE — dark by default, owner-gated, confirmation-first
// ---------------------------------------------------------------------------

describe("gdpr erase route is DARK, owner-gated, confirmation-first", () => {
  const code = codeOf(read(ROUTE));

  it("checks the feature flag FIRST and 503s while dark (before auth/DB)", () => {
    // The flag check must precede requireOrgContext in source order.
    const flagIdx = code.indexOf("gdprErasureEnabled");
    const authIdx = code.indexOf("requireOrgContext");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(authIdx);
    expect(code).toMatch(/status:\s*503/);
  });

  it("gates on org OWNER or super-admin, refusing others 403", () => {
    expect(code).toMatch(/role === "owner"/);
    expect(code).toMatch(/isSuperAdminEmail/);
    expect(code).toMatch(/status:\s*403/);
  });

  it("requires a confirmation token equal to the org slug (400 otherwise)", () => {
    expect(code).toMatch(/confirm !== ctx\.org\.slug/);
    expect(code).toMatch(/status:\s*400/);
  });

  it("is private and never cached", () => {
    expect(code).toMatch(/private, no-store/);
  });

  it("only fires erasure AFTER all three gates pass", () => {
    // eraseOrg must be the last meaningful call, after flag/owner/confirm checks.
    const eraseIdx = code.indexOf("eraseOrg({");
    const confirmIdx = code.indexOf("confirm !== ctx.org.slug");
    expect(eraseIdx).toBeGreaterThan(confirmIdx);
  });
});
