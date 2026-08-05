import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure, reportReadFailure } from "@/lib/supabase/read-failure";
import {
  ORG_EXPORT_TABLES,
  EXCLUDED_FROM_EXPORT,
  redactRow,
} from "@/lib/gdpr/export-tables";

/**
 * GDPR / data-portability EXPORT service — org-pinned, loud-read assembly of ONE
 * organisation's own data into a structured, deterministic archive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPORT ONLY. NO DELETION ANYWHERE.
 * ─────────────────────────────────────────────────────────────────────────────
 * This service READS. It never deletes, anonymises, or mutates a single row.
 * Subject ERASURE (GDPR Art. 17) and org-teardown storage-orphan cleanup are a
 * SEPARATE, legally-gated capability that is intentionally NOT built here. There
 * is deliberately no `.delete(`, `.update(`, or destructive RPC in this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * #456 ORG PINNING IS LOAD-BEARING.
 * ─────────────────────────────────────────────────────────────────────────────
 * `current_org_ids()` (the RLS boundary) returns EVERY org the caller belongs
 * to, so a multi-org admin's UNPINNED read would blend two companies into one
 * export — the exact defect the active-org read slices closed. EVERY read here
 * is `.eq("org_id", orgId)` on the caller-supplied ACTIVE org. Combined with the
 * user-JWT client (RLS still applies underneath as the outer boundary), an admin
 * of org A can never pull org B's rows: RLS forbids orgs they don't belong to,
 * and the `.eq` pin narrows a multi-org member to exactly the active org.
 *
 * We deliberately use the user-JWT client (not service-role): RLS is a SECOND,
 * independent backstop behind the explicit pin. If a pin were ever dropped, RLS
 * still caps the blast radius to the caller's own orgs — never a foreign tenant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECRETS IN THE EXPORT.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two independent layers:
 *   1. TABLE deny-list — credential / provider-secret stores, government
 *      identifiers, platform billing, service telemetry and transient queues are
 *      excluded wholesale (`EXCLUDED_FROM_EXPORT`), so `ORG_EXPORT_TABLES` never
 *      names them.
 *   2. COLUMN redaction — every exported row additionally passes through
 *      `redactRow`, which drops any secret-named column (e.g. a `portal_token`
 *      or `public_token` sitting on an otherwise-exported business table).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOUD READS.
 * ─────────────────────────────────────────────────────────────────────────────
 * A failed read THROWS via `readFailure` rather than degrading to an empty
 * table — an export that silently omits rows because a query errored is the lie
 * loud reads exist to stop. Truncation at the per-table cap is the same class of
 * lie: a partial table is NEVER silent — it sets `truncated`, is reported
 * loudly, and is surfaced on the manifest.
 */

/**
 * Per-table row cap. Reads request one past it (`.limit(cap + 1)`) so truncation
 * is detectable via capRows. It MUST stay < PostgREST max_rows (1000): a higher
 * value is silently clamped to 1000, which made the old 50_000 cap a lie and the
 * `truncated` flag permanently dead (F-1). At 999 the probe reads exactly 1000,
 * so truncation is correctly detected and loudly flagged on the manifest.
 * Full streaming pagination (complete large-tenant export) is the documented
 * activation-hardening step below.
 */
export const MAX_ROWS_PER_TABLE = 999;

/**
 * Minimal read/insert surface. `ORG_EXPORT_TABLES` is a `string[]`, which the
 * fully-typed Supabase client's `.from()` overload rejects (it only knows the
 * generated table union), so we read through this structural view. It is still
 * an ordinary RLS-subject client — this widens no trust boundary.
 */
type ReadError = { message?: string | null; code?: string | null };
type SupabaseLike = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: unknown,
      ): {
        limit(
          n: number,
        ): PromiseLike<{ data: unknown[] | null; error: ReadError | null }>;
      };
    };
  };
};

export type TableExport = {
  table: string;
  rowCount: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
};

export type ExportManifestTable = {
  table: string;
  rowCount: number;
  truncated: boolean;
};

export type ExportManifest = {
  /** Fixed banner so the boundary is unmissable inside the archive itself. */
  export_kind: "gdpr-data-portability-export";
  scope: "export-only — no erasure/teardown (a separate legally-gated capability)";
  org_id: string;
  generated_at: string;
  table_count: number;
  total_rows: number;
  any_truncated: boolean;
  max_rows_per_table: number;
  tables: ExportManifestTable[];
  /** The security deny-list, surfaced so the archive documents what it omits. */
  excluded_tables: { table: string; reason: string }[];
  /**
   * Snapshot tables that were not present in THIS environment's schema (a
   * migrate-first shape difference, benign). Empty on an in-sync database.
   */
  skipped_tables: string[];
};

export type OrgExport = {
  orgId: string;
  generatedAt: string;
  tables: TableExport[];
  manifest: ExportManifest;
};

/**
 * A "relation does not exist" shape difference (PostgREST cannot find the table
 * in its schema cache, or Postgres 42P01), distinct from a real read failure.
 * Matched by code first, message as a fallback for older PostgREST builds.
 */
function isMissingRelation(error: ReadError): boolean {
  const code = (error.code ?? "").toUpperCase();
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

/**
 * Cap a read result and report whether it was truncated. The read over-requests
 * by one row, so a length exceeding the cap means MORE rows existed than were
 * exported; the probe row is sliced off and `truncated` is the loud flag.
 */
function capRows<T>(
  data: readonly T[],
  cap = MAX_ROWS_PER_TABLE,
): { rows: T[]; truncated: boolean } {
  const truncated = data.length > cap;
  return { rows: truncated ? data.slice(0, cap) : data.slice(), truncated };
}

/**
 * Assemble the requesting org's data across every exportable org-scoped table.
 *
 * `generatedAt` is injected so the manifest is deterministic and testable — the
 * assembler never reads a clock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACTIVATION-HARDENING (documented, NOT built — required before large-tenant use)
 * ─────────────────────────────────────────────────────────────────────────────
 *   (a) MEMORY CEILING. This assembles the whole archive in memory: up to
 *       MAX_ROWS_PER_TABLE (50k) rows across every exportable table (~136), then
 *       the route zips it in-memory too. That is bounded but large. Before
 *       enabling for big tenants, STREAM/PAGINATE the reads and stream the zip to
 *       the response rather than buffering the full archive.
 *   (b) NON-DETERMINISTIC TRUNCATION. The `.limit(cap+1)` read has NO `.order()`,
 *       so WHICH rows are dropped when a table exceeds the cap is
 *       Postgres-defined, not deterministic. It is already flagged loudly
 *       (`truncated` + manifest), but a large-tenant activation should add a
 *       stable `.order()` (e.g. by primary key) so truncation is reproducible.
 */
export async function buildOrgExport(params: {
  orgId: string;
  generatedAt: string;
  /**
   * TEST SEAM ONLY. Production passes nothing and the cookie-bound user client
   * is used. The integration tier injects a real user-JWT client so the REAL
   * assembly runs against Postgres with a genuine multi-org member. Whatever is
   * injected is still RLS-subject — this seam widens no boundary.
   */
  client?: SupabaseLike;
}): Promise<OrgExport> {
  const { orgId, generatedAt } = params;
  const supabase: SupabaseLike =
    params.client ?? ((await createClient()) as unknown as SupabaseLike);

  const tables: TableExport[] = [];
  const skipped: string[] = [];

  for (const table of ORG_EXPORT_TABLES) {
    const res = await supabase
      .from(table)
      // #456: pin to the caller's ACTIVE org. RLS is the outer boundary; this
      // is the active-org narrowing for a multi-org member.
      .select("*")
      .eq("org_id", orgId)
      // Over-request by one so a full page reveals truncation (capRows).
      .limit(MAX_ROWS_PER_TABLE + 1);

    if (res.error) {
      // MIGRATE-FIRST TOLERANCE: a table that simply does not exist in THIS
      // environment (a snapshot table ahead of the deployed schema, or behind
      // it) is a benign shape difference, NOT a read failure — skip it and note
      // it on the manifest. Everything else (RLS, network, PGRST embed errors)
      // is a real failure and stays LOUD: never degrade it to an empty table.
      if (isMissingRelation(res.error)) {
        skipped.push(table);
        continue;
      }
      throw readFailure(`gdpr export: ${table}`, res.error);
    }

    const raw = (res.data ?? []) as Record<string, unknown>[];
    const { rows: capped, truncated } = capRows(raw);
    if (truncated) {
      // A partial table is never silent — report it and flag it on the manifest.
      reportReadFailure(`gdpr export: ${table} truncated at cap`, {
        message: `table ${table} hit MAX_ROWS_PER_TABLE=${MAX_ROWS_PER_TABLE}`,
        code: "GDPR_EXPORT_TRUNCATED",
      });
    }

    // Column-level defence in depth: strip any secret-named column.
    const rows = capped.map((r) => redactRow(r) as Record<string, unknown>);
    tables.push({ table, rowCount: rows.length, truncated, rows });
  }

  const totalRows = tables.reduce((n, t) => n + t.rowCount, 0);
  const anyTruncated = tables.some((t) => t.truncated);

  const manifest: ExportManifest = {
    export_kind: "gdpr-data-portability-export",
    scope:
      "export-only — no erasure/teardown (a separate legally-gated capability)",
    org_id: orgId,
    generated_at: generatedAt,
    table_count: tables.length,
    total_rows: totalRows,
    any_truncated: anyTruncated,
    max_rows_per_table: MAX_ROWS_PER_TABLE,
    tables: tables.map((t) => ({
      table: t.table,
      rowCount: t.rowCount,
      truncated: t.truncated,
    })),
    excluded_tables: Object.entries(EXCLUDED_FROM_EXPORT)
      .map(([tableName, reason]) => ({ table: tableName, reason }))
      .sort((a, b) => a.table.localeCompare(b.table)),
    skipped_tables: skipped.slice().sort(),
  };

  return { orgId, generatedAt, tables, manifest };
}

/**
 * Append one accountability row to `gdpr_export_log` (GDPR Art. 5(2)).
 *
 * BEST-EFFORT: the caller must never fail a download over this write — an export
 * that succeeded is not un-done by a missed log row. The write goes through the
 * user-JWT client, so the table's `is_org_admin(org_id)` INSERT policy is the
 * real authorisation boundary (an app-only gate would leave the REST endpoint
 * open to any member). Records ONLY `status='generated'` — this is the export
 * trail; erasure is a separate legally-gated capability with no row here.
 */
export async function recordGdprExport(input: {
  orgId: string;
  createdBy: string;
  format: "zip" | "json";
  tableCount: number;
  rowCount: number;
  truncated: boolean;
  note?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  // gdpr_export_log post-dates the generated types.ts (the expense_budgets /
  // accounting_export_log idiom). Cast to a minimal insert builder — RLS
  // (is_org_admin) is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => PromiseLike<{
        error: { message: string } | null;
      }>;
    };
  };
  const { error } = await loose.from("gdpr_export_log").insert({
    org_id: input.orgId,
    created_by: input.createdBy,
    format: input.format,
    status: "generated",
    table_count: input.tableCount,
    row_count: input.rowCount,
    truncated: input.truncated,
    note: input.note ?? null,
  });
  if (error) {
    console.error("[gdpr] export-log insert failed", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
