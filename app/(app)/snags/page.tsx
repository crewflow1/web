import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../jobs/_form-helpers";
import { EmptyState } from "../_components/empty-state";
import {
  SNAG_PRIORITIES,
  SNAG_PRIORITY_LABELS,
  SNAG_STATUS_LABELS,
  SNAG_STATUSES,
  isTerminalStatus,
  type SnagPriority,
  type SnagStatus,
} from "@/lib/snags/schema";

/**
 * /snags — the site snag list (defect tracking).
 *
 * One row per defect found on site, from first-spotted to signed-off. The
 * list is a single org-scoped flat read; job + assignee names are resolved in
 * two batched lookups (never per-row) so a busy site with hundreds of open
 * snags stays a constant three queries.
 */

type SnagRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  trade: string | null;
  priority: string;
  status: string;
  job_id: string | null;
  assigned_to: string | null;
  due_date: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<SnagStatus, string> = {
  open: "bg-rose-100 text-rose-800",
  in_progress: "bg-amber-100 text-amber-800",
  fixed: "bg-blue-100 text-blue-800",
  verified: "bg-emerald-100 text-emerald-800",
  wont_fix: "bg-slate-100 text-slate-600",
};

const PRIORITY_STYLES: Record<SnagPriority, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid snag.",
  bad_status: "Invalid status.",
  bad_priority: "Invalid priority.",
  bad_assignee: "Invalid assignee.",
  delete_failed: "Couldn't delete that snag.",
  update_failed: "Couldn't update that snag.",
  forbidden: "Only an owner or admin can delete a snag.",
  not_found: "That snag no longer exists.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Snag logged.",
  status: "Status updated.",
  assigned: "Assignee updated.",
  priority: "Priority updated.",
  deleted: "Snag deleted.",
};

type SnagQuery = Promise<{ data: SnagRow[] | null }> & {
  eq: (k: string, v: unknown) => SnagQuery;
};

type SP = Promise<{
  status?: string;
  priority?: string;
  saved?: string;
  error?: string;
}>;

export default async function SnagsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const statusFilter =
    sp.status && (SNAG_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null;
  const priorityFilter =
    sp.priority && (SNAG_PRIORITIES as readonly string[]).includes(sp.priority)
      ? sp.priority
      : null;

  let query = (
    supabase.from("snags" as never) as unknown as {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => { limit: (n: number) => SnagQuery };
      };
    }
  )
    .select(
      "id, title, description, location, trade, priority, status, job_id, assigned_to, due_date, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(500)
    // ACTIVE-org pin — the defects list must be one company's. `SnagQuery`
    // already carries `.eq()` for the status/priority filters, so the pin
    // composes with them.
    .eq("org_id", ctx.org.id);
  if (statusFilter) query = query.eq("status", statusFilter);
  if (priorityFilter) query = query.eq("priority", priorityFilter);
  const { data } = await query;
  const rows = data ?? [];

  // Resolve names in two batched lookups — never per row.
  const jobIds = [
    ...new Set(rows.map((r) => r.job_id).filter((x): x is string => !!x)),
  ];
  const staff = await listStaffForOrg(ctx.org.id);
  const staffMap = new Map(
    staff.map((s) => [s.id, s.full_name || s.email] as const),
  );
  const jobsMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", jobIds);
    for (const j of jobs ?? []) {
      jobsMap.set(j.id, j.customer?.name ?? "Job");
    }
  }

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const openCount = rows.filter((r) => !isTerminalStatus(r.status as SnagStatus)).length;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Snagging</h1>
          <p className="mt-1 text-sm text-slate-600">
            Track every defect from spotted to signed-off, so nothing slips
            before handover.
          </p>
        </div>
        <Link
          href="/snags/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Log a snag
        </Link>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      <div className="space-y-2">
        <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
          <FilterLink param="status" current={sp.status ?? "all"} value="all" label="All" other={sp.priority} />
          {SNAG_STATUSES.map((s) => (
            <FilterLink
              key={s}
              param="status"
              current={sp.status ?? "all"}
              value={s}
              label={SNAG_STATUS_LABELS[s]}
              other={sp.priority}
            />
          ))}
        </nav>
        <nav aria-label="Priority" className="flex flex-wrap gap-2 text-xs">
          <FilterLink param="priority" current={sp.priority ?? "all"} value="all" label="Any priority" other={sp.status} />
          {SNAG_PRIORITIES.map((p) => (
            <FilterLink
              key={p}
              param="priority"
              current={sp.priority ?? "all"}
              value={p}
              label={SNAG_PRIORITY_LABELS[p]}
              other={sp.status}
            />
          ))}
        </nav>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="🧱"
          title={
            statusFilter || priorityFilter
              ? "No snags match this filter"
              : "No snags logged yet"
          }
          body={
            statusFilter || priorityFilter
              ? "Try a different filter, or log a new snag."
              : "Log the first defect you spot on site — add a photo, set who's fixing it, and track it through to sign-off."
          }
          primary={{ href: "/snags/new", label: "Log a snag" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const status = row.status as SnagStatus;
            const priority = row.priority as SnagPriority;
            const overdue =
              !!row.due_date &&
              row.due_date < today &&
              !isTerminalStatus(status);
            const jobName = row.job_id ? jobsMap.get(row.job_id) : null;
            const assignee = row.assigned_to
              ? staffMap.get(row.assigned_to)
              : null;
            return (
              <li
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.medium}`}
                      >
                        {SNAG_PRIORITY_LABELS[priority] ?? row.priority}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {SNAG_STATUS_LABELS[status] ?? row.status}
                      </span>
                      {overdue ? (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                          Overdue
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">
                      {row.title}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      {jobName ? <span>📋 {jobName}</span> : null}
                      {row.location ? <span>📍 {row.location}</span> : null}
                      {row.trade ? <span>🛠 {row.trade}</span> : null}
                      {assignee ? <span>👤 {assignee}</span> : null}
                      {row.due_date ? (
                        <span className={overdue ? "text-red-600" : undefined}>
                          Due {row.due_date}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Link
                    href={`/snags/${row.id}`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        {rows.length} snag{rows.length === 1 ? "" : "s"} shown · {openCount} still
        open.
      </p>
    </div>
  );
}

function FilterLink({
  param,
  current,
  value,
  label,
  other,
}: {
  param: "status" | "priority";
  current: string;
  value: string;
  label: string;
  other?: string;
}) {
  const isActive = current === value;
  const params = new URLSearchParams();
  if (value !== "all") params.set(param, value);
  // Preserve the other axis's filter when switching this one.
  const otherParam = param === "status" ? "priority" : "status";
  if (other) params.set(otherParam, other);
  const qs = params.toString();
  const href = qs ? `/snags?${qs}` : "/snags";
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
