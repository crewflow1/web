import Link from "next/link";
import { formatDateUK } from "@/lib/time/format";
import {
  JOB_MATERIALS_PANEL_LIMIT,
  loadJobMaterialsPanel,
} from "@/server/services/material-requests";
import {
  MATERIAL_REQUEST_STATUS_CLASS,
  MATERIAL_REQUEST_STATUS_LABEL,
} from "@/lib/material-requests/schema";
import { formatMaterialQty } from "@/lib/material-requests/fulfilment";

/**
 * Materials asked for on this job.
 *
 * COMPOSED, NOT REBUILT — the same contract as the diary, snag and safety
 * panels beside it: the materials vertical (app/(app)/materials/requests) owns
 * the lifecycle and every action; this panel is a READ-ONLY window with the
 * numbers a site manager needs before walking off site, linking through for
 * anything else. It reuses lib/material-requests' status vocabulary and the
 * shared overdue rule rather than restating either.
 *
 * ORG-PINNED as well as RLS-scoped, and best-effort: the service degrades a
 * failed read to an empty summary, so a materials hiccup costs this panel and
 * never the job page.
 */

export async function JobMaterialsSection({
  jobId,
  orgId,
  todayIso,
}: {
  jobId: string;
  orgId: string;
  todayIso: string;
}) {
  const summary = await loadJobMaterialsPanel(orgId, jobId, todayIso, JOB_MATERIALS_PANEL_LIMIT);

  return (
    <section
      aria-labelledby="job-materials-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="job-materials-heading" className="text-base font-semibold text-slate-900">
          Materials
        </h2>
        <p className="text-xs text-slate-500">
          {summary.total === 0
            ? "None requested"
            : `${summary.open} open of ${summary.total} requested`}
        </p>
      </div>

      {summary.awaitingApproval > 0 || summary.overdue > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {summary.awaitingApproval > 0 ? (
            <li className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-900">
              {summary.awaitingApproval} awaiting approval
            </li>
          ) : null}
          {summary.overdue > 0 ? (
            <li className="rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800">
              {summary.overdue} past needed-by
            </li>
          ) : null}
        </ul>
      ) : null}

      {summary.total === 0 ? (
        <p className="mt-3 text-sm text-slate-600">
          Nothing requested for this job yet. Anything asked for here goes straight
          to the office for approval.
        </p>
      ) : summary.items.length === 0 ? (
        <p className="mt-3 text-sm text-emerald-800">
          Every materials request on this job is closed out.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {summary.items.map(({ request, fulfilment, overdue }) => (
            <li key={request.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5">
              {/*
                On a phone the description takes the whole line and the badges
                wrap underneath; from `sm` up they share a row. Without
                `basis-full` the pills squeeze the link into a narrow column.
              */}
              <span className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                <Link
                  href={`/materials/requests/${request.id}`}
                  className="break-words font-medium text-slate-900 hover:underline"
                >
                  {request.number}
                </Link>
                <span className="block text-xs text-slate-500">
                  {fulfilment.stockModulePending
                    ? `${fulfilment.lines.length} line${fulfilment.lines.length === 1 ? "" : "s"}`
                    : fulfilment.totalOutstanding > 0
                      ? `${formatMaterialQty(fulfilment.totalOutstanding)} still outstanding`
                      : "Everything issued"}
                </span>
              </span>
              {request.priority === "urgent" ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                  Urgent
                </span>
              ) : null}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${MATERIAL_REQUEST_STATUS_CLASS[request.status]}`}
              >
                {MATERIAL_REQUEST_STATUS_LABEL[request.status]}
              </span>
              {request.needed_by ? (
                <span className={`text-xs ${overdue ? "font-semibold text-red-700" : "text-slate-500"}`}>
                  {overdue ? "Needed " : "By "}
                  <time dateTime={request.needed_by}>{formatDateUK(request.needed_by)}</time>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/materials/requests/new?job=${jobId}`}
          className="min-h-11 rounded-md bg-slate-900 px-3 py-2.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          Request materials
        </Link>
        <Link
          href={`/materials/requests?job=${jobId}&status=all`}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {summary.open > summary.items.length
            ? `All ${summary.open} open requests`
            : "Request history"}
        </Link>
      </div>
    </section>
  );
}
