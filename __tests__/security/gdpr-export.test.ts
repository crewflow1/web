import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ORG_EXPORT_TABLES,
  EXCLUDED_FROM_EXPORT,
  EXPORT_ORDER_KEYS,
  exportOrderKey,
} from "@/lib/gdpr/export-tables";

/**
 * GDPR data-portability EXPORT (20261105) — trust-boundary proofs (hermetic).
 *
 * Section 1: the registry never names a credential store.
 * Section 2: the service is org-pinned (#456), loud, redacts columns, and
 *            contains NO deletion / mutation (export-only).
 * Section 3: the route is admin-gated, private, export-only, and free of AI.
 * Section 4: the export-log migration is member-read / admin-write, append-only,
 *            org-pinned + cascade, carries no money, and has NO erasure outcome.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SERVICE = "server/services/gdpr-export.ts";
const ROUTE = "app/api/gdpr/export/route.ts";
const MIG = "supabase/migrations/20261105000000_gdpr_export_log.sql";

/** Strip TS/JS comments so source contracts test EXECUTABLE code, not prose. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Strip SQL line comments so NEGATIVE assertions test executable statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

// ---------------------------------------------------------------------------
// 1. THE REGISTRY — never a credential store
// ---------------------------------------------------------------------------

describe("gdpr export registry excludes all credential/secret stores", () => {
  it("excludes every OAuth/token/secret table wholesale", () => {
    for (const t of [
      "accounting_connections",
      "bank_connections",
      "calendar_connections",
      "hmrc_connections",
      "api_keys",
      "phone_numbers",
      "webhook_endpoints",
      "whatsapp_number_routes",
      "whatsapp_webhook_events",
      "asset_qr_identities",
      "staff_secrets",
    ]) {
      expect(ORG_EXPORT_TABLES).not.toContain(t);
      expect(EXCLUDED_FROM_EXPORT[t]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. THE PAGING ORDER-KEY REGISTRY — every override is a real exported table
// ---------------------------------------------------------------------------

describe("gdpr export paging order-key registry is well-formed", () => {
  it("every order-key override names a table that IS exported", () => {
    // A stale override (renamed/excluded table) would silently never apply,
    // leaving that table to page by the wrong / a non-existent column. Every
    // key must be a member of the exported set.
    const exported = new Set(ORG_EXPORT_TABLES);
    for (const table of Object.keys(EXPORT_ORDER_KEYS)) {
      expect(exported.has(table), `order-key override for non-exported table ${table}`).toBe(true);
    }
  });

  it("defaults to `id`, and every override is a non-empty column name", () => {
    // The default holds for the overwhelming majority of tables (they carry a
    // unique `id`); overrides exist ONLY for the handful without one.
    expect(exportOrderKey("a_table_with_no_override")).toBe("id");
    for (const [table, col] of Object.entries(EXPORT_ORDER_KEYS)) {
      expect(exportOrderKey(table)).toBe(col);
      expect(typeof col === "string" && col.length > 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE SERVICE — org-pinned, loud, redacting, EXPORT-ONLY
// ---------------------------------------------------------------------------

describe("gdpr export service is org-pinned, loud, redacting, export-only", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on every read (#456)", () => {
    expect(code).toMatch(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/);
    // The pin sits on the caller-supplied active org, not current_org_ids().
    expect(code).toMatch(/orgId/);
  });

  it("reads loudly — a failed read throws, never a silent empty table", () => {
    // fetchAllRows is best-effort (hands back the partial set + the error); the
    // service refuses a partial export and THROWS on any non-missing-relation
    // read error. A missing table is the only tolerated (skipped) shape.
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("reads COMPLETELY — pages every table via fetchAllRows, no per-table cap (F-1)", () => {
    // The DSAR export is statutory: it must contain EVERY org-scoped row. The
    // old `.limit(999+1)` per-table cap silently truncated any table beyond 999
    // rows. The fix pages each table in full under the PostgREST max_rows cap.
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/paginate["']/);
    expect(code).toMatch(/fetchAllRows</);
    expect(code).toMatch(/\.range\(/);
    // A stable, unique order is required so pagination can't drop/repeat rows.
    expect(code).toMatch(/exportOrderKey\(/);
    // No capped read survives on the export path — no `.limit(`, and the old
    // MAX_ROWS_PER_TABLE cap is retired entirely.
    expect(code).not.toMatch(/\.limit\(/);
    expect(code).not.toMatch(/MAX_ROWS_PER_TABLE/);
    // The manifest reports completeness rather than a per-table truncation flag.
    expect(code).toMatch(/complete:\s*true/);
  });

  it("redacts sensitive columns from every row", () => {
    expect(code).toMatch(/redactRow/);
    expect(code).toMatch(/from\s+["']@\/lib\/gdpr\/export-tables["']/);
  });

  it("iterates the derived export set, never a raw table literal loop", () => {
    expect(code).toMatch(/ORG_EXPORT_TABLES/);
  });

  it("contains NO deletion or mutation call — export only", () => {
    // Only destructive DB CALLS are forbidden; the manifest's honest
    // "no erasure/teardown" banner string is expected (asserted below).
    expect(code).not.toMatch(/\.delete\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
    expect(code).not.toMatch(/\.upsert\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
    // The only write is the append-only audit-log INSERT.
    const inserts = code.match(/\.insert\s*\(/g) ?? [];
    expect(inserts.length).toBe(1);
  });

  it("labels itself export-only in the manifest banner", () => {
    expect(code).toMatch(/export-only/i);
    expect(code).toMatch(/gdpr-data-portability-export/);
  });

  it("uses no AI helpers", () => {
    expect(code).not.toMatch(/@\/lib\/ai\//);
  });

  it("the manifest is deterministic (generatedAt injected, never a clock)", () => {
    // The assembler takes generatedAt as a param and must not read the clock.
    expect(code).toMatch(/generatedAt/);
    expect(code).not.toMatch(/new Date\(\)/);
    expect(code).not.toMatch(/Date\.now\(/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ROUTE — admin-gated, private, export-only, no AI
// ---------------------------------------------------------------------------

describe("gdpr export route is admin-gated, private, export-only", () => {
  const code = codeOf(read(ROUTE));

  it("gates on owner/admin and refuses others with 403", () => {
    expect(code).toMatch(/role === "owner"/);
    expect(code).toMatch(/role === "admin"/);
    expect(code).toMatch(/status:\s*403/);
  });

  it("is private and never cached", () => {
    expect(code).toMatch(/private, no-store/);
  });

  it("contains NO deletion call — export only", () => {
    expect(code).not.toMatch(/\.delete\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
  });

  it("uses no AI helpers", () => {
    expect(code).not.toMatch(/@\/lib\/ai\//);
  });

  it("documents the export-only boundary for downloaders (README)", () => {
    expect(read(ROUTE)).toMatch(/EXPORT ONLY/i);
    expect(code).toMatch(/does NOT|not.*delete/i);
  });
});

// ---------------------------------------------------------------------------
// 4. THE EXPORT LOG MIGRATION — RLS, append-only, no money, no erasure outcome
// ---------------------------------------------------------------------------

describe("gdpr_export_log migration", () => {
  const sql = sqlOnly(read(MIG));

  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.gdpr_export_log enable row level security/i,
    );
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert gated on is_org_admin()", () => {
    expect(sql).toMatch(
      /create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
  });

  it("is APPEND-ONLY: no update and no delete policy", () => {
    expect(sql).not.toMatch(/for\s+update/i);
    expect(sql).not.toMatch(/for\s+delete/i);
  });

  it("is org-pinned with a composite candidate key + cascade teardown", () => {
    expect(sql).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });

  it("holds NO money and adds NO trigger (teardown-safe, no double-count)", () => {
    expect(sql).not.toMatch(/amount/i);
    expect(sql).not.toMatch(/trigger/i);
  });

  it("has NO erasure outcome — status is 'generated' only (export-only)", () => {
    expect(sql).toMatch(/status\s+text not null default 'generated' check \(status in \('generated'\)\)/i);
    expect(sql).not.toMatch(/'erased'|'deleted'/i);
  });
});
