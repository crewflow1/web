import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRetentionPolicyInput,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from "@/lib/retention/policy";

/**
 * DATA RETENTION — primitive lockdown, tenant isolation, dry-run, audit, RLS,
 * cron gate, and input validation (hermetic; filesystem + pure functions).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261184000000_retention_policies.sql";
const SERVICE = "server/services/retention-purge.ts";
const ROUTE = "app/api/cron/retention-purge/route.ts";

const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. THE PRIMITIVE — service_role only, SECURITY DEFINER, pinned search_path
// ---------------------------------------------------------------------------
describe("retention_purge_run is locked down", () => {
  const sql = sqlOnly(read(MIG));

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function public\.retention_purge_run/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path\s*=\s*pg_catalog, public, information_schema/i);
  });

  it("revokes anon/authenticated and grants only service_role", () => {
    expect(sql).toMatch(/revoke execute on function public\.retention_purge_run[\s\S]*?from anon, authenticated/i);
    expect(sql).toMatch(/grant\s+execute on function public\.retention_purge_run[\s\S]*?to service_role/i);
    // No blanket grant back to authenticated/anon/public.
    expect(sql).not.toMatch(/grant\s+execute on function public\.retention_purge_run[\s\S]*?to (public|anon|authenticated)/i);
  });

  it("re-checks service_role INSIDE the function (defence in depth)", () => {
    expect(sql).toMatch(/auth\.role\(\)\s+is distinct from\s+'service_role'/i);
  });

  it("refuses any target not on the internal allowlist", () => {
    // v_ts_col stays null unless the target matched a c_allow row → raise.
    expect(sql).toMatch(/if v_ts_col is null then/i);
    expect(sql).toMatch(/is not a purgeable table/i);
  });

  it("enforces the window bounds in SQL", () => {
    expect(sql).toMatch(/p_retention_days\s*<\s*30\s+or\s+p_retention_days\s*>\s*3650/i);
  });
});

// ---------------------------------------------------------------------------
// 2. TENANT ISOLATION — every scan/delete is pinned to p_org_id
// ---------------------------------------------------------------------------
describe("retention_purge_run is tenant-scoped", () => {
  const sql = sqlOnly(read(MIG));

  it("the match count is pinned to org_id = p_org_id", () => {
    expect(sql).toMatch(/select count\(\*\)::integer from public\.%I where org_id = \$1 and %I < \$2/i);
  });

  it("the delete is pinned to org_id = p_org_id", () => {
    // Both the delete and its ctid subselect carry the org pin.
    expect(sql).toMatch(/delete from public\.%I where ctid in/i);
    expect(sql).toMatch(/select ctid from public\.%I where org_id = \$1 and %I < \$2 limit \$3/i);
  });

  it("never issues an unscoped delete over a purgeable table", () => {
    // No `delete from public.%I` without a `where org_id` on the same statement.
    const deletes = [...sql.matchAll(/delete from public\.%I[^;]*/gi)];
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d[0], `unscoped delete: ${d[0]}`).toMatch(/where ctid in/i);
    }
  });

  it("validates the target is an org-scoped base table with the timestamp column", () => {
    expect(sql).toMatch(/table_type = 'BASE TABLE'/i);
    expect(sql).toMatch(/column_name = 'org_id'/i);
    expect(sql).toMatch(/column_name = v_ts_col/i);
  });
});

// ---------------------------------------------------------------------------
// 3. DRY-RUN + AUDIT — preview deletes nothing; every run is logged
// ---------------------------------------------------------------------------
describe("dry-run previews and every run is audited", () => {
  const sql = sqlOnly(read(MIG));

  it("the delete loop only runs when NOT a dry-run", () => {
    expect(sql).toMatch(/if not p_dry_run then/i);
  });

  it("a purge_log row is appended in BOTH modes (single insert, mode-aware)", () => {
    expect(sql).toMatch(/insert into public\.retention_purge_log/i);
    expect(sql).toMatch(/case when p_dry_run then 'dry_run' else 'purge' end/i);
    expect(sql).toMatch(/case when p_dry_run then 'previewed' else 'purged' end/i);
  });

  it("the log table structurally forbids a dry-run from claiming a deletion", () => {
    expect(sql).toMatch(/check \(mode <> 'dry_run' or rows_deleted = 0\)/i);
    expect(sql).toMatch(/check \(rows_deleted <= rows_matched\)/i);
  });
});

// ---------------------------------------------------------------------------
// 4. TABLES + RLS — member-read, admin-write config, write-locked audit log
// ---------------------------------------------------------------------------
describe("retention tables have correct RLS", () => {
  const sql = sqlOnly(read(MIG));

  it("both tables enable RLS", () => {
    expect(sql).toMatch(/alter table public\.retention_policies enable row level security/i);
    expect(sql).toMatch(/alter table public\.retention_purge_log enable row level security/i);
  });

  it("policies are member-read via current_org_ids and admin-write via is_org_admin", () => {
    expect(sql).toMatch(/retention_policies: members select[\s\S]*?org_id in \(select public\.current_org_ids\(\)\)/i);
    expect(sql).toMatch(/retention_policies: admins insert[\s\S]*?with check \(public\.is_org_admin\(org_id\)\)/i);
    expect(sql).toMatch(/retention_policies: admins update[\s\S]*?is_org_admin\(org_id\)/i);
    expect(sql).toMatch(/retention_policies: admins delete[\s\S]*?is_org_admin\(org_id\)/i);
  });

  it("the audit log is member-read but has NO tenant write policy", () => {
    expect(sql).toMatch(/retention_purge_log: members select[\s\S]*?org_id in \(select public\.current_org_ids\(\)\)/i);
    expect(sql).not.toMatch(/create policy[^\n]*retention_purge_log[^\n]*for (insert|update|delete)/i);
  });

  it("target_table is bounded and the window is bounded on the table itself", () => {
    expect(sql).toMatch(/table_name\s+text not null check \(table_name in/i);
    expect(sql).toMatch(/retention_days integer not null check \(retention_days between 30 and 3650\)/i);
  });
});

// ---------------------------------------------------------------------------
// 5. CRON ROUTE — Bearer-gated + telemetry-wrapped
// ---------------------------------------------------------------------------
describe("the retention cron route is gated", () => {
  const route = codeOf(read(ROUTE));

  it("refuses unauthorised callers (isCronAuthorised → 401)", () => {
    expect(route).toMatch(/isCronAuthorised\(request\)/);
    expect(route).toMatch(/status:\s*401/);
  });

  it("wraps the run in cron telemetry", () => {
    expect(route).toMatch(/withCronTelemetry\(\s*["']retention-purge["']/);
    expect(route).toMatch(/runRetentionPurge\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. SERVICE — dark by default, per-(org,table) calls, never cross-org
// ---------------------------------------------------------------------------
describe("the purge service is dark by default and per-tenant", () => {
  const service = codeOf(read(SERVICE));

  it("the destructive flag defaults OFF (cron runs dry-run while dark)", () => {
    expect(service).toMatch(/process\.env\.FEATURE_RETENTION_PURGE === "true"/);
    expect(service).toMatch(/const dryRun = !purgeEnabled/);
  });

  it("passes each policy's own org_id to the primitive (no cross-org fan-out)", () => {
    expect(service).toMatch(/p_org_id:\s*policy\.org_id/);
    expect(service).toMatch(/p_target_table:\s*policy\.table_name/);
  });

  it("refuses a non-purgeable target before calling the primitive", () => {
    expect(service).toMatch(/!isPurgeable\(policy\.table_name\)\s*\|\|\s*isExcluded\(policy\.table_name\)/);
  });

  it("runs the fail-closed disjointness invariant before any destructive work", () => {
    expect(service).toMatch(/assertRetentionSetsDisjoint\(\)/);
  });

  it("previewPolicy always calls the primitive in dry-run", () => {
    expect(service).toMatch(/previewPolicy[\s\S]*?p_dry_run:\s*true/);
  });
});

// ---------------------------------------------------------------------------
// 7. INPUT VALIDATION — the shared parser rejects protected tables + bad windows
// ---------------------------------------------------------------------------
describe("parseRetentionPolicyInput enforces the allowlist and bounds", () => {
  it("accepts a valid purgeable table + window", () => {
    const r = parseRetentionPolicyInput({
      targetTable: "notifications",
      retentionDays: 90,
      enabled: "on",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.targetTable).toBe("notifications");
      expect(r.value.retentionDays).toBe(90);
      expect(r.value.enabled).toBe(true);
    }
  });

  it("rejects a protected/financial table", () => {
    for (const t of ["invoices", "payroll_runs", "activity_log", "hmrc_submissions"]) {
      expect(parseRetentionPolicyInput({ targetTable: t, retentionDays: 90, enabled: "on" }).ok).toBe(false);
    }
  });

  it("rejects an out-of-bounds window", () => {
    expect(parseRetentionPolicyInput({ targetTable: "notifications", retentionDays: MIN_RETENTION_DAYS - 1, enabled: "on" }).ok).toBe(false);
    expect(parseRetentionPolicyInput({ targetTable: "notifications", retentionDays: MAX_RETENTION_DAYS + 1, enabled: "on" }).ok).toBe(false);
    expect(parseRetentionPolicyInput({ targetTable: "notifications", retentionDays: 45.5, enabled: "on" }).ok).toBe(false);
  });

  it("rejects an unknown table name", () => {
    expect(parseRetentionPolicyInput({ targetTable: "does_not_exist", retentionDays: 90, enabled: "on" }).ok).toBe(false);
  });
});
