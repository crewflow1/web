import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  actionIcon,
  describeActivity,
  type ActivityRow,
} from "@/lib/activity/render";
import { formatDateTimeUK } from "@/lib/time/format";

/**
 * Dedicated activity log. Filter by date range, actor, action type
 * (substring of action), and target table.
 */

type SP = Promise<{
  from?: string;
  to?: string;
  actor?: string;
  type?: string;
  target?: string;
  page?: string;
}>;

const PAGE_SIZE = 50;

const TYPE_OPTIONS = [
  { value: "", label: "All types" },
  { value: "job.", label: "Jobs" },
  { value: "quote.", label: "Quotes" },
  { value: "invoice.", label: "Invoices" },
  { value: "finance.", label: "Finances" },
  { value: "lead.", label: "Leads" },
  { value: "time_entry.", label: "Time entries" },
  { value: "payroll.", label: "Payroll" },
  { value: "import.", label: "Imports" },
  { value: "leave.", label: "Leave" },
  { value: "purchase_order.", label: "Purchase orders" },
  { value: "grn.", label: "Deliveries" },
];

const TARGET_OPTIONS = [
  { value: "", label: "All targets" },
  { value: "jobs", label: "Jobs" },
  { value: "quotes", label: "Quotes" },
  { value: "invoices", label: "Invoices" },
  { value: "finances", label: "Finances" },
  { value: "leads", label: "Leads" },
  { value: "customers", label: "Customers" },
  { value: "imports", label: "Imports" },
  { value: "time_entries", label: "Time entries" },
  { value: "purchase_orders", label: "Purchase orders" },
  { value: "goods_received_notes", label: "Deliveries" },
];

export default async function ActivityPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;

  let q = supabase
    .from("activity_log")
    .select(
      "id, actor_id, actor_name, action, target_table, target_id, metadata, created_at",
      { count: "exact" },
    )
    // ACTIVE-org pin — the audit trail must be one company's; RLS admits every
    // org the viewer belongs to, so both audit logs were interleaved and the
    // exact count paginated over the blend.
    .eq("org_id", ctx.org.id)
    // Unique `id` tiebreaker: `created_at` alone is not a total order, so events
    // sharing a timestamp could be skipped or repeated at a page boundary.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (sp.from) q = q.gte("created_at", `${sp.from}T00:00:00Z`);
  if (sp.to) q = q.lte("created_at", `${sp.to}T23:59:59.999Z`);
  if (sp.actor && sp.actor.length > 0) q = q.ilike("actor_name", `%${sp.actor}%`);
  if (sp.type && sp.type.length > 0) q = q.like("action", `${sp.type}%`);
  if (sp.target && sp.target.length > 0) q = q.eq("target_table", sp.target);

  const { data: rows, count } = await q;
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Activity</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every change in your CrewFlow account, in one place. Use the
          filters to narrow down. Triggered notifications fan out from
          here to the bell icon.
        </p>
      </header>

      <form
        method="GET"
        className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-5"
      >
        <label className="block text-xs text-slate-600">
          From
          <input
            type="date"
            name="from"
            defaultValue={sp.from ?? ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs text-slate-600">
          To
          <input
            type="date"
            name="to"
            defaultValue={sp.to ?? ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs text-slate-600">
          Actor
          <input
            type="text"
            name="actor"
            placeholder="e.g. Jane"
            defaultValue={sp.actor ?? ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs text-slate-600">
          Type
          <select
            name="type"
            defaultValue={sp.type ?? ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-600">
          Target
          <select
            name="target"
            defaultValue={sp.target ?? ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {TARGET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="col-span-2 flex items-end gap-2 md:col-span-5">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Apply
          </button>
          <Link
            href="/activity"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Clear
          </Link>
          <span className="ml-auto text-xs text-slate-500">
            {total} {total === 1 ? "event" : "events"}
          </span>
        </div>
      </form>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {(rows ?? []).length === 0 ? (
          <p className="p-6 text-sm text-slate-500">No activity matches these filters.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {((rows ?? []) as unknown as ActivityRow[]).map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                <span aria-hidden className="text-lg">{actionIcon(r.action)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-900">
                    <span className="font-medium">{r.actor_name ?? "system"}</span>{" "}
                    {describeActivity(r)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {r.target_table} · {r.target_id.slice(0, 8)} ·{" "}
                    {formatDateTimeUK(r.created_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {totalPages > 1 ? (
        <nav className="flex items-center justify-between text-sm">
          <Link
            href={`/activity?${buildQuery(sp, page - 1)}`}
            aria-disabled={page <= 1}
            className={
              page <= 1
                ? "pointer-events-none rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
                : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            }
          >
            ← Newer
          </Link>
          <span className="text-xs text-slate-500">
            Page {page} of {totalPages}
          </span>
          <Link
            href={`/activity?${buildQuery(sp, page + 1)}`}
            aria-disabled={page >= totalPages}
            className={
              page >= totalPages
                ? "pointer-events-none rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
                : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            }
          >
            Older →
          </Link>
        </nav>
      ) : null}
    </div>
  );
}

function buildQuery(sp: Record<string, string | undefined>, page: number): string {
  const out = new URLSearchParams();
  for (const k of ["from", "to", "actor", "type", "target"]) {
    if (sp[k]) out.set(k, sp[k]!);
  }
  out.set("page", String(page));
  return out.toString();
}
