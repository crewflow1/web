import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import { listNcrs, type NcrListItem } from "./_data";
import {
  NCR_SEVERITY_META,
  NCR_STATUS_META,
  isLive,
  type NcrSeverity,
  type NcrStatus,
} from "@/lib/quality/ncr";

/**
 * /quality/ncrs — the non-conformance register (M2).
 *
 * The question this page answers in one glance: WHAT DOES NOT CONFORM, and how
 * bad. Live NCRs lead, criticals first — everything closed or cancelled is
 * history below. NCRs are NOT snags: these are checks against an issued
 * inspection plan that failed, each demanding a verified corrective action.
 *
 * Reads via the data layer: ACTIVE-org pinned, loud on failure — an empty
 * register on a failed read would claim the works conform.
 */

const FILTERS = [
  { key: "live", label: "Live" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Closed / cancelled" },
  { key: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const ERROR_MAP: Record<string, string> = {
  bad_id: "That NCR reference was invalid.",
  not_found: "That record no longer exists.",
  not_editable: "An NCR under corrective action is frozen. The corrective-action record carries what changed.",
  proposal_already_pending: "A corrective action is already awaiting review on this NCR.",
  already_decided: "That corrective action has already been decided.",
  not_completable: "Only an accepted, not-yet-completed corrective action can be completed.",
  not_closable: "An NCR closes only after its corrective action is completed.",
};

const SAVED_MAP: Record<string, string> = {
  raised: "NCR raised.",
  updated: "NCR saved.",
  action_proposed: "Corrective action proposed. It is now awaiting review.",
  action_accepted: "Corrective action accepted. Record completion when the works are corrected.",
  action_rejected: "Corrective action rejected. Propose a new one.",
  action_completed: "Corrective work recorded as completed. Verify and close the NCR.",
  closed: "NCR closed with verification.",
  cancelled: "NCR cancelled.",
};

type SP = Promise<{ saved?: string; error?: string; filter?: string }>;

function matches(n: NcrListItem, filter: Filter): boolean {
  switch (filter) {
    case "live":
      return isLive(n.status);
    case "open":
      return n.status === "open";
    case "in_progress":
      return (
        n.status === "corrective_action_proposed" ||
        n.status === "corrective_action_approved" ||
        n.status === "completed"
      );
    case "resolved":
      return n.status === "closed" || n.status === "cancelled";
    default:
      return true;
  }
}

const SEVERITY_ORDER: Record<NcrSeverity, number> = { critical: 0, major: 1, minor: 2 };

export default async function NcrRegisterPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const rows = await listNcrs(ctx.org.id);

  const filter: Filter = FILTERS.find((f) => f.key === sp.filter)?.key ?? "live";
  const visible = rows
    .filter((r) => matches(r, filter))
    .sort((a, b) =>
      isLive(a.status) === isLive(b.status)
        ? SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
        : isLive(a.status)
          ? -1
          : 1,
    );

  const liveRows = rows.filter((r) => isLive(r.status));
  const criticals = liveRows.filter((r) => r.severity === "critical");

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Non-conformance</span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Non-conformance reports</h1>
        <p className="mt-1 text-sm text-slate-600">
          Works checked against an issued inspection plan that did not conform.
          Each NCR is anchored to a plan item, carries a responsible party, and
          closes only after a verified corrective action. Defects found on a
          walkdown belong in Snagging, not here.
        </p>
      </header>

      {criticals.length > 0 ? (
        <section
          aria-labelledby="ncr-critical-heading"
          className="rounded-xl border border-red-200 bg-red-50 p-5 shadow-sm"
        >
          <h2 id="ncr-critical-heading" className="text-sm font-semibold text-red-900">
            {criticals.length} critical non-conformance{criticals.length === 1 ? "" : "s"} live
          </h2>
          <ul className="mt-3 space-y-2">
            {criticals.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/quality/ncrs/${n.id}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-red-200 bg-white px-3 py-2.5 text-sm transition hover:bg-red-50/60"
                >
                  <span className="font-mono text-xs font-medium text-slate-600">{n.reference}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{n.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${NCR_STATUS_META[n.status as NcrStatus].tone}`}>
                    {NCR_STATUS_META[n.status as NcrStatus].label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <nav aria-label="Filter NCRs" className="flex flex-wrap gap-2 text-sm">
          {FILTERS.map((f) => {
            const active = f.key === filter;
            const count = rows.filter((r) => matches(r, f.key)).length;
            return (
              <Link
                key={f.key}
                href={f.key === "live" ? "/quality/ncrs" : `/quality/ncrs?filter=${f.key}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 font-medium ${
                  active
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                {f.label}{" "}
                <span className={`ml-1 ${active ? "text-slate-300" : "text-slate-600"}`}>
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState
            icon="⚠️"
            title="No non-conformance reports"
            body="When a check against an inspection plan fails, raise an NCR from the plan's item — it tracks the corrective action through to a verified closure."
            primary={{ href: "/quality", label: "Go to the plans" }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="Nothing matches that filter"
            body="Try another filter, or view all NCRs."
            primary={{ href: "/quality/ncrs?filter=all", label: "View all" }}
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/quality/ncrs/${n.id}`}
                  className="block px-4 py-4 transition hover:bg-slate-50 sm:px-5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs font-medium text-slate-600">{n.reference}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                      {n.title}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${NCR_SEVERITY_META[n.severity as NcrSeverity].tone}`}
                    >
                      {NCR_SEVERITY_META[n.severity as NcrSeverity].label}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${NCR_STATUS_META[n.status as NcrStatus].tone}`}
                    >
                      {NCR_STATUS_META[n.status as NcrStatus].label}
                    </span>
                  </div>
                  <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                    {n.planReference ? (
                      <div>
                        <dt className="sr-only">Plan</dt>
                        <dd>
                          {n.planReference}
                          {n.itemNumber !== null ? ` · item ${n.itemNumber}` : ""}
                          {n.itemTitle ? ` — ${n.itemTitle}` : ""}
                        </dd>
                      </div>
                    ) : null}
                    {n.due_date ? (
                      <div>
                        <dt className="sr-only">Due</dt>
                        <dd>Due {n.due_date}</dd>
                      </div>
                    ) : null}
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
