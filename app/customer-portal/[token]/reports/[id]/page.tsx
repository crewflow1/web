import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { loadPortalReport } from "@/app/customer-portal/_reports";
import { isCurrentReport } from "@/lib/site-reports/portal";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import type { ReportContent } from "@/lib/site-reports/schema";

/**
 * Customer portal — a single issued progress report. Renders ONLY the frozen
 * snapshot (loadPortalReport enforces customer + org + visibility). Never rebuilt
 * from live source records.
 */
export default async function PortalReportPage({
  params,
}: {
  params: Promise<{ token: string; id: string }>;
}) {
  const { token, id } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) notFound();
  const report = await loadPortalReport(loaded.customer.id, loaded.customer.org_id, id);
  if (!report || !report.snapshot) notFound();

  const snap = report.snapshot;
  const c: ReportContent = snap.content ?? {};
  const current = isCurrentReport(report);
  const snagList = (snap.sources?.snags ?? []) as Array<{
    title?: string;
    status?: string;
    priority?: string;
    location?: string | null;
  }>;

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <div className="mb-4">
        <Link
          href={`/customer-portal/${token}/reports`}
          className="text-xs font-medium text-slate-500 hover:text-slate-900"
        >
          ← All reports
        </Link>
      </div>

      <header className="mb-4 flex items-center gap-3">
        {loaded.org.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={loaded.org.logo_url} alt="" className="h-9 w-auto" />
        ) : null}
        <p className="text-sm font-semibold text-slate-900">{loaded.org.name}</p>
      </header>

      {!current ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This is a superseded report.{" "}
          <Link href={`/customer-portal/${token}/reports`} className="font-medium underline">
            See the latest report
          </Link>
          .
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{snap.title}</h1>
            <p className="mt-1 text-sm text-slate-500">
              {snap.report_number ? `${snap.report_number} · ` : ""}
              {formatDiaryDate(snap.period_start)} – {formatDiaryDate(snap.period_end)}
              {snap.issued_at ? ` · issued ${snap.issued_at.slice(0, 10)}` : ""}
            </p>
          </div>
          <a
            href={`/customer-portal/${token}/reports/${report.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            Download PDF
          </a>
        </div>

        {c.overall_status || c.current_phase || c.progress_percent != null ? (
          <p className="mt-4 text-sm text-slate-700">
            {[
              c.overall_status ? `Status: ${c.overall_status}` : null,
              c.current_phase ? `Phase: ${c.current_phase}` : null,
              c.progress_percent != null ? `Progress: ${c.progress_percent}%` : null,
            ]
              .filter(Boolean)
              .join("   ·   ")}
          </p>
        ) : null}

        {c.client_decisions ? (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">
              Decisions we need from you
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-blue-900">
              {c.client_decisions}
            </p>
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          <Section title="Summary" text={c.summary} />
          <Section title="Achievements this period" text={c.achievements} />
          <Section title="Work planned next period" text={c.work_planned} />
          <Section title="Programme & progress" text={c.programme_notes} />
          <Section title="Completion forecast" text={c.completion_forecast} />
          <Section title="Weather impact" text={c.weather_notes} />
          <Section title="Risks & blockers" text={c.risks} />
          <Section title="Next steps" text={c.next_steps} />

          {snagList.length > 0 ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Snags &amp; issues
              </p>
              <ul className="mt-1 space-y-1">
                {snagList.slice(0, 40).map((s, i) => (
                  <li key={i} className="text-sm text-slate-700">
                    {s.title}
                    {s.location ? ` — ${s.location}` : ""}
                    {s.status ? ` (${String(s.status).replace(/_/g, " ")})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({ title, text }: { title: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{text}</p>
    </div>
  );
}
