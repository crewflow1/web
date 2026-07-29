import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import type { ReportContent, ReportSnapshot } from "@/lib/site-reports/schema";
import {
  isDeletable,
  isEditable,
  SITE_REPORT_STATUS_LABELS,
  type SiteReportStatus,
} from "@/lib/site-reports/state";
import { isPortalVisible } from "@/lib/site-reports/portal";
import {
  approveReport,
  archiveReport,
  deleteSiteReport,
  issueReport,
  publishToPortal,
  returnToDraft,
  submitForReview,
  supersedeReport,
  updateReportContent,
  withdrawFromPortal,
} from "../actions";

type ReportRow = {
  id: string;
  report_number: string | null;
  title: string;
  status: string;
  revision: number;
  job_id: string | null;
  period_start: string;
  period_end: string;
  content: ReportContent | null;
  snapshot: ReportSnapshot | null;
  approved_at: string | null;
  issued_at: string | null;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
  created_at: string;
};

const SAVED_MAP: Record<string, string> = {
  created: "Draft created — CrewFlow gathered the period's site information below.",
  content: "Saved.",
  status: "Report updated.",
  issued: "Report issued and frozen. It's now a permanent record.",
  superseded: "New revision started from the issued report.",
  published: "Published — the customer can now see this report in their portal.",
  withdrawn: "Withdrawn from the customer portal.",
};
const ERROR_MAP: Record<string, string> = {
  validation: "Please check the form.",
  update_failed: "Couldn't save. Try again.",
  not_editable: "This report can't be edited in its current state.",
  bad_transition: "That action isn't allowed from the current status.",
  not_deletable: "Only a draft can be deleted — issued reports are evidence.",
  no_job: "This report has no linked job.",
  not_issued: "Only an issued report can be published to the portal.",
  not_published: "This report isn't published to the portal.",
  forbidden: "Only an owner or admin can publish or withdraw reports.",
};

const STATUS_STYLES: Record<SiteReportStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  ready_for_review: "bg-amber-100 text-amber-800",
  approved: "bg-indigo-100 text-indigo-800",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
  archived: "bg-slate-100 text-slate-600", // slate-600, not 400: AA contrast on slate-100
};

export default async function SiteReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const { data: report } = await (
    supabase.from("site_reports" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: ReportRow | null }>;
          };
        };
      };
    }
  )
    .select(
      "id, report_number, title, status, revision, job_id, period_start, period_end, content, snapshot, approved_at, issued_at, portal_published_at, portal_withdrawn_at, created_at",
    )
    .eq("id", id)
    // ACTIVE-org pin — a client-facing report has publish/withdraw actions on
    // this page, so it must be the ACTIVE org's report or nothing.
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  if (!report) notFound();

  const status = report.status as SiteReportStatus;
  const editable = isEditable(status);
  const canDelete =
    (ctx.membership.role === "owner" || ctx.membership.role === "admin") &&
    isDeletable(status);
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const portalVisible = isPortalVisible({
    status: report.status,
    portal_published_at: report.portal_published_at,
    portal_withdrawn_at: report.portal_withdrawn_at,
  });

  let jobName: string | null = null;
  if (report.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", report.job_id)
      .maybeSingle();
    jobName = job?.customer?.name ?? "Job";
  }

  const content = report.content ?? {};
  const sel = content.sources;
  const counts = {
    diary: sel?.diary_entry_ids.length ?? 0,
    snags: sel?.snag_ids.length ?? 0,
    toolbox: sel?.toolbox_talk_ids.length ?? 0,
  };

  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link
          href="/site-reports"
          className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Site reports
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{report.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              {report.report_number ? (
                <span className="font-mono">{report.report_number}</span>
              ) : null}
              {report.revision > 1 ? <span>rev {report.revision}</span> : null}
              <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[status]}`}>
                {SITE_REPORT_STATUS_LABELS[status]}
              </span>
              {jobName ? <span>· {jobName}</span> : null}
              <span>
                · {formatDiaryDate(report.period_start)} – {formatDiaryDate(report.period_end)}
              </span>
            </div>
          </div>
          <a
            href={`/api/site-reports/${report.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            {status === "issued" ? "Download PDF" : "Preview PDF"}
          </a>
        </div>
      </header>

      {savedMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {/* Lifecycle controls — each is a server action, gated by the state machine. */}
      <section className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {status === "draft" ? (
          <ActionButton action={submitForReview.bind(null, report.id)} label="Submit for review" primary />
        ) : null}
        {status === "ready_for_review" ? (
          <>
            <ActionButton action={approveReport.bind(null, report.id)} label="Approve" primary />
            <ActionButton action={returnToDraft.bind(null, report.id)} label="Back to draft" />
          </>
        ) : null}
        {status === "approved" ? (
          <>
            <ActionButton action={issueReport.bind(null, report.id)} label="Issue report" primary />
            <ActionButton action={returnToDraft.bind(null, report.id)} label="Back to draft" />
          </>
        ) : null}
        {status === "issued" ? (
          <ActionButton action={supersedeReport.bind(null, report.id)} label="Start new revision" primary />
        ) : null}
        {status !== "archived" && status !== "superseded" ? (
          <ActionButton action={archiveReport.bind(null, report.id)} label="Archive" />
        ) : null}
        {canDelete ? (
          <ActionButton action={deleteSiteReport.bind(null, report.id)} label="Delete draft" danger />
        ) : null}
        <span className="ml-auto text-xs text-slate-500">
          {status === "issued"
            ? `Issued ${report.issued_at?.slice(0, 10) ?? ""} — frozen`
            : editable
              ? "Editable"
              : "Locked"}
        </span>
      </section>

      {(status === "issued" || status === "superseded") && isAdmin ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div>
            <p className="text-sm font-semibold text-slate-900">Customer portal</p>
            <p className="text-xs text-slate-500">
              {portalVisible
                ? "The customer can see this report in their portal."
                : "Not visible to the customer yet."}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            {portalVisible ? (
              <ActionButton
                action={withdrawFromPortal.bind(null, report.id)}
                label="Withdraw from portal"
              />
            ) : status === "issued" ? (
              <ActionButton
                action={publishToPortal.bind(null, report.id)}
                label="Publish to portal"
                primary
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Gathered site information (deterministic aggregation, author-curated). */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Gathered from site</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          What CrewFlow pulled from this job for the reporting period.
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
          <Stat n={counts.diary} label="Diary entries" />
          <Stat n={counts.snags} label="Snags" />
          <Stat n={counts.toolbox} label="Toolbox talks" />
        </dl>
      </section>

      {editable ? (
        <CommentaryForm id={report.id} content={content} />
      ) : (
        <IssuedView content={content} snapshot={report.snapshot} />
      )}

      {/* Report-level attachments (cover image / extra evidence). */}
      <AttachmentsPanel targetTable="site_reports" targetId={report.id} />
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-xl font-semibold text-slate-900">{n}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ActionButton({
  action,
  label,
  primary,
  danger,
}: {
  action: () => void | Promise<void>;
  label: string;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = danger
    ? "border border-red-300 bg-white text-red-700 hover:bg-red-50"
    : primary
      ? "bg-slate-900 text-white hover:bg-slate-800"
      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <form action={action}>
      <button type="submit" className={`rounded-md px-3 py-1.5 text-xs font-semibold ${cls}`}>
        {label}
      </button>
    </form>
  );
}

const FIELDS: Array<{ name: keyof ReportContent; label: string; rows?: number }> = [
  { name: "overall_status", label: "Overall status (e.g. On track / Delayed)" },
  { name: "current_phase", label: "Current phase" },
  { name: "summary", label: "Executive summary", rows: 4 },
  { name: "achievements", label: "Achievements this period", rows: 3 },
  { name: "work_planned", label: "Work planned next period", rows: 3 },
  { name: "programme_notes", label: "Programme & progress notes", rows: 3 },
  { name: "completion_forecast", label: "Completion forecast" },
  { name: "weather_notes", label: "Weather impact", rows: 2 },
  { name: "risks", label: "Risks & blockers", rows: 3 },
  { name: "client_decisions", label: "Client decisions required", rows: 3 },
  { name: "next_steps", label: "Next steps", rows: 3 },
];

function CommentaryForm({ id, content }: { id: string; content: ReportContent }) {
  return (
    <form
      action={updateReportContent}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <input type="hidden" name="id" value={id} />
      <h2 className="text-base font-semibold text-slate-900">Report commentary</h2>
      <div>
        <label htmlFor="progress_percent" className="block text-sm font-medium text-slate-800">
          Progress %
        </label>
        <input
          id="progress_percent"
          name="progress_percent"
          type="number"
          min={0}
          max={100}
          defaultValue={content.progress_percent ?? ""}
          className="mt-1.5 block w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>
      {FIELDS.map((f) => (
        <div key={f.name}>
          <label htmlFor={f.name} className="block text-sm font-medium text-slate-800">
            {f.label}
          </label>
          {f.rows ? (
            <textarea
              id={f.name}
              name={f.name}
              rows={f.rows}
              defaultValue={(content[f.name] as string | undefined) ?? ""}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          ) : (
            <input
              id={f.name}
              name={f.name}
              type="text"
              defaultValue={(content[f.name] as string | undefined) ?? ""}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          )}
        </div>
      ))}
      <button
        type="submit"
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Save report
      </button>
    </form>
  );
}

function IssuedView({
  content,
  snapshot,
}: {
  content: ReportContent;
  snapshot: ReportSnapshot | null;
}) {
  const c = snapshot?.content ?? content;
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Report content</h2>
        {snapshot ? (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            Frozen snapshot
          </span>
        ) : null}
      </div>
      {c.progress_percent != null ? (
        <p className="text-sm text-slate-700">Progress: {c.progress_percent}%</p>
      ) : null}
      {FIELDS.map((f) => {
        const v = c[f.name] as string | undefined;
        if (!v) return null;
        return (
          <div key={f.name}>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {f.label}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{v}</p>
          </div>
        );
      })}
    </section>
  );
}
