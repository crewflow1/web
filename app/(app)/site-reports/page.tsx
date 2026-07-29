import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../_components/empty-state";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import {
  SITE_REPORT_STATUS_LABELS,
  SITE_REPORT_STATUSES,
  type SiteReportStatus,
} from "@/lib/site-reports/state";

/**
 * /site-reports — formal, client-ready progress reports. One org-scoped read;
 * job names resolve in one batched lookup.
 */

type ReportRow = {
  id: string;
  report_number: string | null;
  title: string;
  status: string;
  revision: number;
  job_id: string | null;
  period_start: string;
  period_end: string;
  issued_at: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<SiteReportStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  ready_for_review: "bg-amber-100 text-amber-800",
  approved: "bg-indigo-100 text-indigo-800",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
  archived: "bg-slate-100 text-slate-600", // slate-600, not 400: AA contrast on slate-100
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "Invalid report.",
  not_found: "That report no longer exists.",
  forbidden: "Only an owner or admin can delete a report.",
  delete_failed: "Couldn't delete that report.",
};
const SAVED_MAP: Record<string, string> = {
  created: "Draft report created.",
  content: "Report saved.",
  status: "Report updated.",
  issued: "Report issued.",
  superseded: "New revision started.",
  deleted: "Report deleted.",
};

type ReportQuery = Promise<{ data: ReportRow[] | null }> & {
  eq: (k: string, v: unknown) => ReportQuery;
};

type SP = Promise<{ status?: string; job?: string; saved?: string; error?: string }>;

export default async function SiteReportsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const statusFilter =
    sp.status && (SITE_REPORT_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null;

  let query = (
    supabase.from("site_reports" as never) as unknown as {
      select: (cols: string) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => { limit: (n: number) => ReportQuery };
      };
    }
  )
    .select(
      "id, report_number, title, status, revision, job_id, period_start, period_end, issued_at, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(500)
    // ACTIVE-org pin — client-facing reports must not interleave companies.
    .eq("org_id", ctx.org.id);
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data } = await query;
  const rows = data ?? [];

  const jobIds = [
    ...new Set(rows.map((r) => r.job_id).filter((x): x is string => !!x)),
  ];
  const jobsMap = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", jobIds);
    for (const j of jobs ?? []) jobsMap.set(j.id, j.customer?.name ?? "Job");
  }

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Site reports</h1>
          <p className="mt-1 text-sm text-slate-600">
            Formal progress reports for clients — CrewFlow pulls together the site
            diary, snags and safety talks; you review, approve and issue.
          </p>
        </div>
        <Link
          href="/site-reports/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + New report
        </Link>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}

      <nav aria-label="Status" className="flex flex-wrap gap-2 text-xs">
        <StatusFilter current={sp.status ?? "all"} value="all" label="All" />
        {SITE_REPORT_STATUSES.map((s) => (
          <StatusFilter
            key={s}
            current={sp.status ?? "all"}
            value={s}
            label={SITE_REPORT_STATUS_LABELS[s]}
          />
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          icon="📑"
          title={statusFilter ? "No reports with this status" : "No site reports yet"}
          body="Create your first progress report — pick a job and a period, and CrewFlow gathers the site information for you to review and issue."
          primary={{ href: "/site-reports/new", label: "Create a report" }}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const status = row.status as SiteReportStatus;
            const jobName = row.job_id ? jobsMap.get(row.job_id) : null;
            return (
              <li key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {row.report_number ? (
                        <span className="font-mono text-slate-500">{row.report_number}</span>
                      ) : null}
                      <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
                        {SITE_REPORT_STATUS_LABELS[status] ?? row.status}
                      </span>
                      {row.revision > 1 ? (
                        <span className="text-slate-500">rev {row.revision}</span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">{row.title}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      {jobName ? <span>📋 {jobName}</span> : null}
                      <span>
                        {formatDiaryDate(row.period_start)} – {formatDiaryDate(row.period_end)}
                      </span>
                    </div>
                  </div>
                  <Link
                    href={`/site-reports/${row.id}`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-slate-500">{rows.length} report{rows.length === 1 ? "" : "s"} shown.</p>
    </div>
  );
}

function StatusFilter({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href = value === "all" ? "/site-reports" : `/site-reports?status=${value}`;
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
