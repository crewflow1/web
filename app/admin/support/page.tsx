import Link from "next/link";
import { listSupportTicketsForHq } from "@/server/services/hq-support-snapshot";
import {
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_PILL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_PRIORITY_PILL,
  SUPPORT_CATEGORY_LABEL,
  SUPPORT_STATUSES,
  SUPPORT_PRIORITIES,
  SUPPORT_CATEGORIES,
  SUPPORT_SORTS,
  SUPPORT_SORT_LABELS,
  SUPPORT_ACTIVE_STATUSES,
  filterTickets,
  sortTickets,
  type SupportStatus,
  type SupportPriority,
  type SupportCategory,
  type SupportSort,
} from "@/lib/hq/support";

/**
 * HQ Support queue — /admin/support (HQ-7).
 *
 * Cross-tenant. Service-role read (bypasses RLS). The list shows
 * every ticket across every org, with filters + sort. Click a
 * row to open /admin/support/<id> for the full thread + status
 * controls + internal-notes view.
 */

type SP = Promise<{
  q?: string;
  status?: string;
  priority?: string;
  category?: string;
  sort?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function HqSupportListPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status =
    (sp.status as SupportStatus | "all" | "active" | undefined) ?? "active";
  const priority =
    (sp.priority as SupportPriority | "all" | undefined) ?? "all";
  const category =
    (sp.category as SupportCategory | "all" | undefined) ?? "all";
  const sort = (SUPPORT_SORTS.includes(sp.sort as SupportSort)
    ? sp.sort
    : "needs_attention") as SupportSort;

  const all = await listSupportTicketsForHq();
  const filtered = filterTickets(all, { q, status, priority, category });
  const sorted = sortTickets(filtered, sort);

  // KPI tiles use the FULL ticket set, not the filtered view, so the
  // operator sees system-wide truth.
  const active = all.filter((t) =>
    SUPPORT_ACTIVE_STATUSES.includes(t.status as SupportStatus),
  );
  const urgent = active.filter((t) => t.priority === "urgent").length;
  const oweCustomer = active.filter(
    (t) => t.last_reply_kind === "customer",
  ).length;
  const resolved7d = all.filter((t) => {
    if (!t.resolved_at) return false;
    const days =
      (Date.now() - new Date(t.resolved_at).getTime()) / 86_400_000;
    return days <= 7;
  }).length;

  const banner = (() => {
    if (sp.saved)
      return { tone: "ok" as const, msg: `Saved (${sp.saved}).` };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            HQ · Support queue
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            All customer tickets
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Cross-tenant ticket queue. Sort defaults to &ldquo;needs
            attention&rdquo;: active tickets where the customer was last to
            reply, oldest first.
          </p>
        </div>
        <Link
          href="/admin/overview"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          ← HQ overview
        </Link>
      </header>

      {banner ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.msg}
        </div>
      ) : null}

      {/* KPI tiles */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Active" value={String(active.length)} tone="amber" />
        <Kpi label="Urgent active" value={String(urgent)} tone="red" />
        <Kpi
          label="Awaiting CrewFlow"
          value={String(oweCustomer)}
          tone="indigo"
        />
        <Kpi
          label="Resolved this week"
          value={String(resolved7d)}
          tone="emerald"
        />
      </section>

      {/* Filter bar */}
      <form
        method="get"
        action="/admin/support"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Search
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="subject, customer, #number"
            className="mt-1 w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Status
          <select
            name="status"
            defaultValue={status}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="active">Active (default)</option>
            {SUPPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUPPORT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Priority
          <select
            name="priority"
            defaultValue={priority}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            {SUPPORT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {SUPPORT_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Category
          <select
            name="category"
            defaultValue={category}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            {SUPPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {SUPPORT_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Sort
          <select
            name="sort"
            defaultValue={sort}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {SUPPORT_SORTS.map((s) => (
              <option key={s} value={s}>
                {SUPPORT_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
        >
          Apply
        </button>
        <Link
          href="/admin/support"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      {/* List */}
      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No tickets match these filters.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
          {sorted.map((t) => (
            <li key={t.id} className="px-4 py-3 hover:bg-slate-50">
              <Link
                href={`/admin/support/${t.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      #{t.ticket_number}
                    </span>
                    <span className="text-sm font-semibold text-slate-900">
                      {t.subject}
                    </span>
                    {t.has_internal_notes ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                        internal notes
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-medium text-slate-700">
                      {t.org_name ?? t.org_id.slice(0, 8)}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_STATUS_PILL[t.status as SupportStatus]}`}
                    >
                      {SUPPORT_STATUS_LABEL[t.status as SupportStatus] ?? t.status}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_PRIORITY_PILL[t.priority as SupportPriority]}`}
                    >
                      {SUPPORT_PRIORITY_LABEL[t.priority as SupportPriority] ?? t.priority}
                    </span>
                    <span className="text-slate-500">
                      {SUPPORT_CATEGORY_LABEL[t.category as SupportCategory] ?? t.category}
                    </span>
                  </p>
                  {t.last_reply_preview ? (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-600">
                      {t.last_reply_preview}
                    </p>
                  ) : null}
                </div>
                <p className="text-[11px] text-slate-500">
                  {t.last_reply_at
                    ? `${t.last_reply_kind === "customer" ? "Customer replied" : "We replied"} ${t.last_reply_at.slice(0, 10)}`
                    : `Created ${t.created_at.slice(0, 10)}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "red" | "amber" | "indigo" | "emerald";
}) {
  const t: Record<typeof tone, string> = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
  };
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${t[tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-75">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
