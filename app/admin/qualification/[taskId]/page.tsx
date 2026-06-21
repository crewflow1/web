import { notFound } from "next/navigation";
import Link from "next/link";
import { Filter, ShieldCheck } from "lucide-react";
import {
  getQualificationReport,
  getQualificationRunState,
} from "@/server/services/hq-qualification";
import { STATUS_LABEL, STATUS_PILL } from "../_styles";
import { BackToQualification } from "../_components";
import { LiveRun } from "./_live";
import { QualificationReport } from "./_report";

/**
 * Lead Qualification AI — single run view (CEO Directive 003, Module 3).
 *
 * One URL for the whole lifecycle of a qualify_company task. While the run is
 * in flight it renders the live, polling checklist; the moment it finishes it
 * renders the full verdict — the decision, the fit score it was made on, the
 * five weighted criteria, and the plain-English rationale — from the same task
 * row. The client view refreshes this route on completion, so the hand-off is
 * seamless.
 */

export const dynamic = "force-dynamic";

export default async function QualificationRunPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;
  const state = await getQualificationRunState(taskId);
  if (!state) notFound();

  const terminal =
    state.status === "completed" ||
    state.status === "failed" ||
    state.status === "cancelled";
  const report = terminal ? await getQualificationReport(taskId) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Filter className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <div className="mb-1">
                <BackToQualification />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                {state.companyName ?? "Qualifying…"}
              </h1>
              <p className="mt-0.5 text-sm text-slate-400">
                Lead Qualification AI · deterministic verdict
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${STATUS_PILL[state.status]}`}
            >
              {STATUS_LABEL[state.status]}
            </span>
            {state.companyId ? (
              <Link
                href={`/admin/sales/companies/${state.companyId}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Company record
              </Link>
            ) : null}
          </div>
        </div>
        <div className="relative mt-4 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Deterministic · reversible · only ever moves a lead out of &lsquo;new&rsquo;
        </div>
      </div>

      {/* Body — live while running, verdict when finished */}
      <div className="p-5 sm:p-7">
        {terminal && report ? (
          <QualificationReport report={report} />
        ) : (
          <LiveRun taskId={taskId} seed={state} />
        )}
      </div>
    </div>
  );
}
