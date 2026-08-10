import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  ORG_EXPORT_TABLES,
  EXCLUDED_FROM_EXPORT,
  exportOrderKey,
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
 * LOUD READS + COMPLETE READS.
 * ─────────────────────────────────────────────────────────────────────────────
 * A failed read THROWS via `readFailure` rather than degrading to an empty
 * table — an export that silently omits rows because a query errored is the lie
 * loud reads exist to stop.
 *
 * Completeness is the other half of the same duty. A statutory Art.15/Art.20
 * export MUST contain EVERY org-scoped row, so each table is read in full via
 * `fetchAllRows` (pages under the PostgREST `max_rows` cap on a stable, unique
 * order — see `exportOrderKey`). The former `.limit(999+1)` per-table cap
 * silently delivered a PARTIAL file to any tenant with >999 rows in a table
 * (time_entries / notifications / invoices / …): an incomplete statutory export
 * is still incomplete even when the shortfall is flagged. Full pagination
 * removes the truncation entirely, so the manifest reports `complete: true`
 * rather than a per-table `truncated` flag.
 */

/**
 * Minimal read surface for the paged export. `ORG_EXPORT_TABLES` is a `string[]`,
 * which the fully-typed Supabase client's `.from()` overload rejects (it only
 * knows the generated table union), so we read through this structural view. It
 * is still an ordinary RLS-subject client — this widens no trust boundary. The
 * builder mirrors the `fetchAllRows` contract: `.range(from, to)` on a stable
 * `.order()`.
 */
type ReadError = { message?: string | null; code?: string | null };
type PageBuilder = {
  select(columns: string): PageBuilder;
  eq(column: string, value: unknown): PageBuilder;
  order(column: string, opts: { ascending: boolean }): PageBuilder;
  range(
    from: number,
    to: number,
  ): PromiseLike<{ data: unknown[] | null; error: ReadError | null }>;
};
type SupabaseLike = {
  from(table: string): PageBuilder;
};

export type TableExport = {
  table: string;
  rowCount: number;
  rows: Record<string, unknown>[];
};

export type ExportManifestTable = {
  table: string;
  rowCount: number;
};

export type ExportManifest = {
  /** Fixed banner so the boundary is unmissable inside the archive itself. */
  export_kind: "gdpr-data-portability-export";
  scope: "export-only — no erasure/teardown (a separate legally-gated capability)";
  org_id: string;
  generated_at: string;
  table_count: number;
  total_rows: number;
  /**
   * Every exported table is read in full via `fetchAllRows` (no per-table cap),
   * so a produced export is always complete. Kept as an explicit, positive
   * signal inside the archive itself (replaces the old `any_truncated` /
   * `max_rows_per_table` truncation machinery, which is gone now that nothing
   * truncates).
   */
  complete: true;
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
 * Assemble the requesting org's data across every exportable org-scoped table.
 *
 * `generatedAt` is injected so the manifest is deterministic and testable — the
 * assembler never reads a clock.
 *
 * COMPLETE READS. Every table is paged in full via `fetchAllRows` on a stable,
 * unique order (`exportOrderKey`), so the export contains ALL org-scoped rows —
 * the F-1 fix for the per-table `.limit(999)` cap that silently truncated any
 * table beyond 999 rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACTIVATION-HARDENING (documented, NOT built — required before large-tenant use)
 * ─────────────────────────────────────────────────────────────────────────────
 *   (a) MEMORY CEILING. The reads are now complete (paged), but the whole archive
 *       is still assembled in memory and the route zips it in-memory too. That is
 *       the remaining bound. Before enabling for very large tenants, STREAM the
 *       zip to the response rather than buffering the full archive. (`fetchAllRows`
 *       carries its own 500k-row-per-table sanity ceiling that logs loudly — far
 *       past any launch-horizon single-org volume — so a table cannot page
 *       unboundedly.)
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
    // COMPLETE READ (F-1). Page the whole table under the PostgREST max_rows cap
    // via fetchAllRows, on a stable + unique order so no page can drop or repeat
    // a row. The old single `.limit(999+1)` shot silently truncated any table
    // with >999 rows, delivering a PARTIAL statutory export.
    const { data, error } = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        supabase
          .from(table)
          // #456: pin to the caller's ACTIVE org. RLS is the outer boundary;
          // this is the active-org narrowing for a multi-org member.
          .select("*")
          .eq("org_id", orgId)
          // Stable, unique total ordering (its `id`, or the composite-key
          // override) so pagination can't shift rows across page boundaries.
          .order(exportOrderKey(table), { ascending: true })
          .range(from, to) as unknown as PromiseLike<
          PageResult<Record<string, unknown>>
        >,
    );

    if (error) {
      // MIGRATE-FIRST TOLERANCE: a table that simply does not exist in THIS
      // environment (a snapshot table ahead of the deployed schema, or behind
      // it) is a benign shape difference, NOT a read failure — skip it and note
      // it on the manifest. Everything else (RLS, network, PGRST embed errors)
      // is a real failure and stays LOUD: never degrade it to an empty table.
      // fetchAllRows is best-effort (returns the partial set + the error) — we
      // refuse a partial export and throw.
      const readError = error as ReadError;
      if (isMissingRelation(readError)) {
        skipped.push(table);
        continue;
      }
      throw readFailure(`gdpr export: ${table}`, readError);
    }

    // Column-level defence in depth: strip any secret-named column.
    const rows = data.map((r) => redactRow(r) as Record<string, unknown>);
    tables.push({ table, rowCount: rows.length, rows });
  }

  const totalRows = tables.reduce((n, t) => n + t.rowCount, 0);

  const manifest: ExportManifest = {
    export_kind: "gdpr-data-portability-export",
    scope:
      "export-only — no erasure/teardown (a separate legally-gated capability)",
    org_id: orgId,
    generated_at: generatedAt,
    table_count: tables.length,
    total_rows: totalRows,
    complete: true,
    tables: tables.map((t) => ({
      table: t.table,
      rowCount: t.rowCount,
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
