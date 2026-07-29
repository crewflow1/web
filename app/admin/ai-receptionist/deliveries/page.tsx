import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireHqPage } from "@/server/auth/hq";
import {
  LIFECYCLE_FILTERS,
  LIFECYCLE_STAGE_LABELS,
  LIFECYCLE_STAGE_STYLES,
  VERDICT_LABELS,
  VERDICT_STYLES,
  deriveLifecycleStage,
  formatLifecycleTimestamp,
  isLifecycleFilter,
  stageMatchesFilter,
  type LifecycleFilter,
  type LifecycleRow,
} from "@/lib/ai-receptionist/lifecycle";

/**
 * /admin/ai-receptionist/deliveries — HQ delivery monitoring for the AI Receptionist
 * (Directive #018, R9: DELIVERY MONITORING — OPERATOR VISIBILITY).
 *
 * READ-ONLY. Every value comes from the `ai_reply_lifecycle` view (audit ⟕ transport ⟕
 * latest receipt); this page reads it and renders it — it never writes to any ledger, never
 * sends anything, never reaches a provider. It answers, for the most recent replies, the
 * eight operator questions: was a reply produced, was it allowed/held/blocked, was a
 * transport attempted, did it send or fail, its provider message id, the terminal delivery
 * status, when each step happened, and what caused any failure. Click a row for the full
 * per-reply chain.
 *
 * Filter by triage bucket via ?filter=held|awaiting|delivered|failed (default: all).
 */

// The lifecycle view is a service-role-only internal (not in the generated Database
// types), so the query is cast to the minimal surface this page reads — the same
// `as never` convention the setups page uses for ai_receptionist_setups.
const VIEW_COLUMNS =
  "audit_id, org_id, employee_slug, channel, enquiry_id, lead_id, customer_ref, " +
  "correlation_id, draft, verdict, allowed, categories, enforcement_reason, safe_text, " +
  "audit_at, transport_id, transport_status, transport_provider, provider_message_id, " +
  "transport_failure_reason, to_ref, attempt, cost_usd, latency_ms, dedup_key, " +
  "transport_at, receipt_id, delivery_status, delivery_terminal, " +
  "delivery_provider_status, delivery_error_code, receipt_at, receipt_count";

type OrgLite = { id: string; name: string | null; slug: string | null };

type SP = Promise<{ filter?: string }>;

export default async function HqReceptionistDeliveriesPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireHqPage();

  const sp = await searchParams;
  const filter: LifecycleFilter = isLifecycleFilter(sp.filter) ? sp.filter : "all";
  const supabase = createAdminClient();

  // Newest 500 lifecycle rows, unfiltered — we bucket + filter in memory so the pill
  // counts and the rendered rows share one predicate (stageMatchesFilter) and can never
  // disagree. Read-only: a plain SELECT against the view.
  const result = await supabase
    .from("ai_reply_lifecycle" as never)
    .select(VIEW_COLUMNS)
    .order("audit_at", { ascending: false })
    .limit(500);

  const allRows = ((result as { data?: LifecycleRow[] | null }).data ?? []) as LifecycleRow[];

  // Enrich with organisation names for the operator (read-only lookup). One query for the
  // distinct orgs on screen; a missing org simply shows its id.
  const orgIds = Array.from(new Set(allRows.map((r) => r.org_id)));
  const orgById = new Map<string, OrgLite>();
  if (orgIds.length > 0) {
    const orgsRes = await supabase
      .from("organizations" as never)
      .select("id, name, slug")
      .in("id" as never, orgIds as never);
    for (const o of ((orgsRes as { data?: OrgLite[] | null }).data ?? []) as OrgLite[]) {
      orgById.set(o.id, o);
    }
  }

  // Bucket counts for the filter pills, then the filtered slice we render.
  const counts: Record<LifecycleFilter, number> = {
    all: allRows.length,
    held: 0,
    awaiting: 0,
    delivered: 0,
    failed: 0,
  };
  for (const row of allRows) {
    const stage = deriveLifecycleStage(row);
    for (const f of LIFECYCLE_FILTERS) {
      if (f.key !== "all" && stageMatchesFilter(stage, f.key)) counts[f.key]++;
    }
  }

  const rows = allRows.filter((row) => stageMatchesFilter(deriveLifecycleStage(row), filter));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/admin/ai-receptionist" className="hover:text-slate-900">
          AI Receptionist setups
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Reply delivery monitoring</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Reply delivery monitoring</h1>
        <p className="mt-1 text-sm text-slate-600">
          Read-only view of the receptionist reply lifecycle — enforcement verdict,
          transport attempt, provider message id and delivery receipt — for the 500 most
          recent replies. Nothing here sends, retries or edits: it reports what the
          append-only ledgers already recorded.
        </p>
      </header>

      <nav aria-label="Filter" className="flex flex-wrap gap-2 text-xs">
        {LIFECYCLE_FILTERS.map((f) => (
          <FilterPill
            key={f.key}
            current={filter}
            value={f.key}
            label={`${f.label} (${counts[f.key]})`}
          />
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-600">
          No replies in this bucket yet.
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Reply</th>
                <th className="px-4 py-3">Transport</th>
                <th className="px-4 py-3">Delivery</th>
                <th className="px-4 py-3">Stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm">
              {rows.map((row) => {
                const stage = deriveLifecycleStage(row);
                const org = orgById.get(row.org_id);
                const rowKey = `${row.audit_id}:${row.transport_id ?? "none"}`;
                return (
                  <tr key={rowKey} className="hover:bg-slate-50 align-top">
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {formatLifecycleTimestamp(row.audit_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/ai-receptionist/deliveries/${row.audit_id}`}
                        className="font-medium text-slate-900 hover:text-slate-700"
                      >
                        {org?.name ?? "Unknown org"}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {row.customer_ref ?? org?.slug ?? row.org_id.slice(0, 8)}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          VERDICT_STYLES[row.verdict] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {VERDICT_LABELS[row.verdict] ?? row.verdict}
                      </span>
                      <p className="mt-1 max-w-xs truncate text-xs text-slate-600">
                        {row.draft}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      {row.transport_id ? (
                        <>
                          <span
                            className={
                              row.transport_status === "sent"
                                ? "font-medium text-emerald-700"
                                : "font-medium text-red-700"
                            }
                          >
                            {row.transport_status}
                          </span>
                          {row.transport_failure_reason ? (
                            <p className="text-slate-500">{row.transport_failure_reason}</p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      {row.receipt_id ? (
                        <>
                          <span className="font-medium">{row.delivery_status}</span>
                          {row.delivery_error_code ? (
                            <p className="text-slate-500">err {row.delivery_error_code}</p>
                          ) : null}
                        </>
                      ) : row.transport_status === "sent" ? (
                        <span className="text-blue-700">awaiting</span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${LIFECYCLE_STAGE_STYLES[stage]}`}
                      >
                        {LIFECYCLE_STAGE_LABELS[stage]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function FilterPill({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href =
    value === "all"
      ? "/admin/ai-receptionist/deliveries"
      : `/admin/ai-receptionist/deliveries?filter=${value}`;
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}
