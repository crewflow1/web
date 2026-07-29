import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listMySupportTickets } from "@/server/services/customer-support-service";
import {
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_PILL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_PRIORITY_PILL,
  SUPPORT_CATEGORY_LABEL,
  filterTickets,
  sortTickets,
  SUPPORT_STATUSES,
  SUPPORT_SORTS,
  SUPPORT_SORT_LABELS,
  type SupportStatus,
  type SupportSort,
} from "@/lib/hq/support";

/**
 * Customer-side support tickets list.
 *
 * RLS scopes the result set to the user's org. The page mirrors the
 * HQ list visually but hides HQ-only data (assignment, org name,
 * internal notes preview).
 */

type SP = Promise<{
  q?: string;
  status?: string;
  sort?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function CustomerSupportPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status =
    (sp.status as SupportStatus | "all" | "active" | undefined) ?? "all";
  const sort = (SUPPORT_SORTS.includes(sp.sort as SupportSort)
    ? sp.sort
    : "needs_attention") as SupportSort;

  const rows = await listMySupportTickets(ctx.org.id);
  const filtered = filterTickets(rows, { q, status });
  const sorted = sortTickets(filtered, sort);

  const banner = (() => {
    if (sp.saved === "1")
      return { tone: "ok" as const, msg: "Ticket created — we'll be in touch." };
    if (sp.saved === "reply")
      return { tone: "ok" as const, msg: "Reply sent." };
    if (sp.error === "create_failed")
      return {
        tone: "err" as const,
        msg: "Couldn't create ticket. Try again or email hello@crewflow.uk.",
      };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Workspace · Support
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            Your support tickets
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Anything blocking you — billing, onboarding, a bug, a feature
            ask — raise it here and the CrewFlow team will reply.
          </p>
        </div>
        <Link
          href="/support/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          New ticket
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

      {/* Filter bar */}
      <form
        method="get"
        action="/support"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Search
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="subject or #number"
            className="mt-1 w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
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
            <option value="active">Active (open + in progress)</option>
            {SUPPORT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SUPPORT_STATUS_LABEL[s]}
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
          href="/support"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      {/* List */}
      {sorted.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">No tickets yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Stuck on something?{" "}
            <Link href="/support/new" className="font-medium text-slate-900 hover:underline">
              Raise your first ticket.
            </Link>
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
          {sorted.map((t) => (
            <li key={t.id} className="px-4 py-3 hover:bg-slate-50">
              <Link
                href={`/support/${t.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      #{t.ticket_number}
                    </span>
                    <span className="text-sm font-semibold text-slate-900">
                      {t.subject}
                    </span>
                    {/* Segment the two conversations that share this table:
                        a portal thread with your own customer vs your helpdesk
                        thread with CrewFlow. customer_id is the only marker. */}
                    {t.customer_id ? (
                      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                        From your customer
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_STATUS_PILL[t.status as SupportStatus]}`}
                    >
                      {SUPPORT_STATUS_LABEL[t.status as SupportStatus] ?? t.status}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_PRIORITY_PILL[t.priority as keyof typeof SUPPORT_PRIORITY_PILL]}`}
                    >
                      {SUPPORT_PRIORITY_LABEL[t.priority as keyof typeof SUPPORT_PRIORITY_LABEL] ?? t.priority}
                    </span>
                    <span className="text-slate-500">
                      {SUPPORT_CATEGORY_LABEL[t.category as keyof typeof SUPPORT_CATEGORY_LABEL] ?? t.category}
                    </span>
                  </p>
                </div>
                <p className="text-[11px] text-slate-500">
                  {t.last_reply_at
                    ? `Last reply ${t.last_reply_at.slice(0, 10)} (${
                        t.last_reply_kind === "hq"
                          ? "CrewFlow"
                          : // 'customer' on a portal thread is the END-CUSTOMER;
                            // on a CrewFlow thread it is this org. 'org' is
                            // always this org replying to its customer.
                            t.last_reply_kind === "customer" && t.customer_id
                            ? "your customer"
                            : "you"
                      })`
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
