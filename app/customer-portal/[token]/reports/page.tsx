import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { listPortalReports } from "@/app/customer-portal/_reports";
import { isCurrentReport } from "@/lib/site-reports/portal";
import { formatDiaryDate } from "@/lib/site-diary/schema";

/**
 * Customer portal — progress reports for this customer's projects. Only issued,
 * published, non-withdrawn reports appear (listPortalReports enforces it). The
 * URL token is the credential; a bad/expired token reveals nothing.
 */
export default async function PortalReportsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) notFound();
  const { customer, org } = loaded;

  const reports = await listPortalReports(customer.id, customer.org_id);

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center gap-3">
        {org.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logo_url} alt="" className="h-10 w-auto" />
        ) : null}
        <div>
          <p className="text-sm font-semibold text-slate-900">{org.name}</p>
          <h1 className="text-lg font-bold text-slate-900">Progress reports</h1>
        </div>
      </header>

      {reports.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-3xl">📑</p>
          <p className="mt-2 text-sm font-medium text-slate-900">No reports yet</p>
          <p className="mt-1 text-sm text-slate-500">
            When {org.name} publishes a progress report for your project, it will
            appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => {
            const current = isCurrentReport(r);
            return (
              <li
                key={r.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {r.report_number ? (
                        <span className="font-mono text-slate-500">{r.report_number}</span>
                      ) : null}
                      {current ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
                          Latest
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">
                          Superseded
                        </span>
                      )}
                      {r.revision > 1 ? (
                        <span className="text-slate-400">rev {r.revision}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm font-medium text-slate-900">{r.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {formatDiaryDate(r.period_start)} – {formatDiaryDate(r.period_end)}
                      {r.issued_at ? ` · issued ${r.issued_at.slice(0, 10)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link
                      href={`/customer-portal/${token}/reports/${r.id}`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      View
                    </Link>
                    <a
                      href={`/customer-portal/${token}/reports/${r.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      PDF
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
