import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  readFailure,
  reportReadFailure,
  type SupabaseReadError,
} from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  RETENTION_PURGEABLE,
  RETENTION_PURGEABLE_TABLES,
} from "@/lib/retention/policy";
import { retentionPurgeEnabled } from "@/server/services/retention-purge";
import { gdprErasureEnabled } from "@/server/services/gdpr-erase";
import { saveRetentionPolicy, previewRetentionPolicy } from "./actions";
import { GdprEraseForm } from "./_gdpr-erase.client";
import {
  RetentionTableRow,
  type RetentionPolicyView,
  type RetentionTableView,
} from "./_forms";

/**
 * Settings → Data retention.
 *
 * Configure, per high-volume operational table, how long rows are kept before
 * they age out. Owners/admins edit; other members see a read-only view. Only the
 * tables on the POSITIVE ALLOWLIST (lib/retention/policy.ts) are configurable —
 * statutory/financial/audit data can never be purged and never appears here.
 */
export default async function DataRetentionSettingsPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  // Current policies for this org. Fail loud — rendering blank defaults over a
  // failed read would let a save flip a policy the admin didn't mean to touch.
  // types.ts predates migration 20261184000000, so the two new tables are read
  // through a loose cast (the settings/page.tsx ai_receptionist_setups idiom).
  type PolicyRow = {
    table_name: string;
    retention_days: number;
    enabled: boolean;
  };
  const { data: policyRows, error: policyError } = await (
    supabase.from("retention_policies" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ data: PolicyRow[] | null; error: SupabaseReadError | null }>;
      };
    }
  )
    .select("table_name, retention_days, enabled")
    .eq("org_id", ctx.org.id);
  if (policyError) throw readFailure("data-retention: policies", policyError);

  const byTable = new Map<string, RetentionPolicyView>();
  for (const row of policyRows ?? []) {
    byTable.set(row.table_name, {
      retentionDays: row.retention_days,
      enabled: row.enabled,
    });
  }

  // Recent purge/preview history (member-readable). Panel-scoped failure.
  type LogRow = {
    table_name: string;
    mode: string;
    retention_days: number;
    rows_matched: number;
    rows_deleted: number;
    status: string;
    created_at: string;
  };
  const { data: logRows, error: logError } = await (
    supabase.from("retention_purge_log" as never) as unknown as {
      select: (cols: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            limit: (
              n: number,
            ) => Promise<{ data: LogRow[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("table_name, mode, retention_days, rows_matched, rows_deleted, status, created_at")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (logError) reportReadFailure("data-retention: purge log", logError);

  const tables: RetentionTableView[] = RETENTION_PURGEABLE_TABLES.map((t) => ({
    table: t,
    label: RETENTION_PURGEABLE[t]!.label,
    description: RETENTION_PURGEABLE[t]!.description,
    timestampColumn: RETENTION_PURGEABLE[t]!.timestampColumn,
  }));

  const purgeLive = retentionPurgeEnabled();
  const erasureLive = gdprErasureEnabled();
  const isOwner = ctx.membership.role === "owner";

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <header>
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Settings
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Data retention</h1>
        <p className="mt-1 text-sm text-slate-600">
          Automatically age out high-volume operational logs after a window you
          choose. Financial, payroll, tax and audit records are protected and
          never purged.
        </p>
      </header>

      {/* Mode banner ---------------------------------------------------- */}
      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          purgeLive
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "border-blue-200 bg-blue-50 text-blue-900"
        }`}
      >
        {purgeLive ? (
          <>
            <strong>Purging is live.</strong> Enabled policies delete matching
            rows on the daily retention run. Use “Preview” first to see exactly
            what a policy would remove.
          </>
        ) : (
          <>
            <strong>Preview mode.</strong> The daily retention run currently
            records what <em>would</em> be purged but deletes nothing. Enable a
            policy now and it starts purging the moment purging is switched on.
          </>
        )}
      </div>

      {!isAdmin ? (
        <div className="rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
          Read only · ask an owner or admin to change retention policies.
        </div>
      ) : null}

      {/* Policy editors ------------------------------------------------- */}
      <section className="space-y-4">
        {tables.map((meta) => (
          <RetentionTableRow
            key={meta.table}
            meta={meta}
            policy={byTable.get(meta.table) ?? null}
            isAdmin={isAdmin}
            saveAction={saveRetentionPolicy}
            previewAction={previewRetentionPolicy}
          />
        ))}
      </section>

      {/* Recent activity ------------------------------------------------ */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Recent retention activity
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Every purge and preview is recorded here for audit.
        </p>
        {logError ? (
          <p className="mt-4 text-sm text-red-700">
            Couldn&apos;t load the retention history. Refresh to try again.
          </p>
        ) : (logRows ?? []).length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No retention runs yet.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Table</th>
                  <th className="py-2 pr-3 font-medium">Mode</th>
                  <th className="py-2 pr-3 font-medium">Window</th>
                  <th className="py-2 pr-3 font-medium">Matched</th>
                  <th className="py-2 pr-3 font-medium">Deleted</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(logRows ?? []).map((r, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2 pr-3 text-slate-600">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <code className="text-xs text-slate-700">{r.table_name}</code>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {r.mode === "dry_run" ? "Preview" : "Purge"}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{r.retention_days}d</td>
                    <td className="py-2 pr-3 text-slate-600">{r.rows_matched}</td>
                    <td className="py-2 pr-3 text-slate-600">{r.rows_deleted}</td>
                    <td className="py-2 text-slate-600 capitalize">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* GDPR — export (live) ------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Export all workspace data (GDPR)
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Download a ZIP archive of your organisation&apos;s own data — one JSON
          file per table, with a manifest listing what is included and what is
          deliberately excluded (credentials, tokens and government identifiers
          are never exported). Exporting changes nothing in your account, and
          every export is recorded for audit.
        </p>
        {isAdmin ? (
          // A plain link — the route is itself admin-gated and streams the ZIP.
          <a
            href="/api/gdpr/export"
            className="mt-4 inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Download data export (ZIP)
          </a>
        ) : (
          <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
            Only an owner or admin can generate the organisation-wide export.
          </p>
        )}
      </section>

      {/* GDPR — erasure -------------------------------------------------- */}
      <section className="rounded-xl border border-red-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          Erase this organisation&apos;s data (GDPR right to erasure)
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Erasure permanently removes personal data: statutory financial, tax,
          payroll and CIS records are anonymised in place (the figures are kept
          for their legal retention window, the personal details are scrubbed),
          everything else is hard-deleted, and all stored files are removed.
          It cannot be undone, and every erasure is recorded in an append-only
          log.
        </p>
        {!erasureLive ? (
          // HONEST DARK STATE — self-serve erasure is deliberately not enabled;
          // the API refuses (503) while the deployment flag is off, so this
          // panel documents the support-assisted path instead of a dead button.
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-900">
            <p className="font-semibold">
              Erasure is a support-assisted process for this workspace.
            </p>
            <p className="mt-1">
              To begin, contact support from your owner account. We verify the
              request with the organisation owner, agree a date, then run the
              erasure described above and send you the confirmation record.
              Consider downloading a data export first — after erasure there is
              nothing left to export.
            </p>
          </div>
        ) : !isOwner ? (
          <p className="mt-4 rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
            Only the organisation owner can start an erasure.
          </p>
        ) : (
          <div className="mt-4">
            <GdprEraseForm orgSlug={ctx.org.slug} />
          </div>
        )}
      </section>
    </div>
  );
}
