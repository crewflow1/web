import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { listVariationRequests, type VariationListItem } from "./_data";
import {
  VARIATION_REQUEST_STATUS_LABELS,
  VARIATION_REQUEST_URGENCY_LABELS,
  type VariationRequestStatus,
} from "@/lib/variation-requests/schema";

/**
 * /variations — the cross-job Variation-requests register.
 *
 * The question this page answers: WHAT HAS THE CLIENT (or site) ASKED FOR that
 * hasn't yet been turned into a priced Variation Order. Requests are raised
 * job-scoped (from the job workspace, or by a customer/worker); this org-wide
 * register is how the commercial desk makes sure none is forgotten between "the
 * client asked" and "we priced it".
 *
 * Read-only compose over the _data layer: ACTIVE-org pinned, loud on failure
 * (a rejected read must never render as "no variations requested"). Rows link
 * back to the owning job, where the variation panel does the actual work.
 */

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "requested", label: "Requested" },
  { key: "reviewing", label: "In review" },
  { key: "accepted", label: "Accepted" },
  { key: "converted", label: "Variation created" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const STATUS_STYLES: Record<VariationRequestStatus, string> = {
  requested: "bg-amber-100 text-amber-800",
  reviewing: "bg-sky-100 text-sky-800",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-slate-100 text-slate-600", // slate-600 for AA contrast on slate-100
  converted: "bg-violet-100 text-violet-800",
};

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  normal: "bg-slate-100 text-slate-700",
  low: "bg-slate-100 text-slate-600",
};

type SP = Promise<{ filter?: string }>;

function matches(v: VariationListItem, filter: Filter): boolean {
  switch (filter) {
    case "open":
      return v.status === "requested" || v.status === "reviewing";
    case "all":
      return true;
    default:
      return v.status === filter;
  }
}

export default async function VariationsRegisterPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const rows = await listVariationRequests(ctx.org.id);

  const filter: Filter = FILTERS.find((f) => f.key === sp.filter)?.key ?? "open";
  const visible = rows.filter((r) => matches(r, filter));

  const open = rows.filter((r) => r.status === "requested" || r.status === "reviewing");
  const accepted = rows.filter((r) => r.status === "accepted");
  const converted = rows.filter((r) => r.status === "converted");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Variations</h1>
        <p className="mt-1 text-sm text-slate-600">
          Everything the client or the site has asked for that changes the agreed scope.
          Triage each request, then turn an accepted one into a priced variation from the
          job it belongs to — so nothing changes on site without being costed.
        </p>
      </header>

      {rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Open</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{open.length}</p>
            <p className="text-[11px] text-slate-500">awaiting a decision</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Accepted</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{accepted.length}</p>
            <p className="text-[11px] text-slate-500">to be priced</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Priced</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{converted.length}</p>
            <p className="text-[11px] text-slate-500">variation created</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{rows.length}</p>
          </div>
        </div>
      ) : null}

      <nav aria-label="Filter variation requests" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "open" ? "/variations" : `/variations?filter=${f.key}`}
            aria-current={filter === f.key ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm ${
              filter === f.key
                ? "bg-slate-900 font-medium text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {visible.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No variation requests yet" : "Nothing matches this filter"}
          body={
            rows.length === 0
              ? "When the client asks for something outside the agreed scope, raise a variation request from the job — it lands here so it gets priced before the work happens."
              : "Try another filter."
          }
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {visible.map((v) => (
            <li key={v.id}>
              <Link href={`/jobs/${v.job_id}`} className="block px-4 py-3 hover:bg-slate-50">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-slate-900">{v.title}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[v.status]}`}
                  >
                    {VARIATION_REQUEST_STATUS_LABELS[v.status]}
                  </span>
                  {v.urgency === "high" ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${URGENCY_STYLES.high}`}
                    >
                      {VARIATION_REQUEST_URGENCY_LABELS.high}
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-slate-500">{v.created_at.slice(0, 10)}</span>
                </div>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  {v.jobLabel ? <span>{v.jobLabel}</span> : null}
                  <span>
                    by {v.requester_name ?? "—"}
                    {v.requester_type === "customer"
                      ? " (customer)"
                      : v.requester_type === "worker_token"
                        ? " (site)"
                        : ""}
                  </span>
                  {v.variation_quote_id ? <span>variation linked</span> : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
