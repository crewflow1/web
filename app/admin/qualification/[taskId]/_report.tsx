import Link from "next/link";
import { ArrowRight, ListChecks, ScrollText, ShieldCheck, Target } from "lucide-react";
import { decisionLabel } from "@/lib/qualification/model";
import { SCORE_BAND_LABELS } from "@/lib/sales/model";
import type { QualificationReportView } from "@/server/services/hq-qualification";
import { CriterionRow, DecisionBadge, Panel, Tile, VerdictDial } from "../_components";

/**
 * Lead Qualification AI — the completed verdict (CEO Directive 003, Module 3).
 *
 * The destination of a finished run: the call (qualified | disqualified | needs
 * review), the fit score it was made on, the five weighted criteria laid bare,
 * and the ordered plain-English rationale. Everything shown is something the
 * deterministic rubric actually produced — an unevidenced criterion is listed
 * and marked Unknown, never invented. This is the "no black box" promise made
 * visible.
 */

export function QualificationReport({ report }: { report: QualificationReportView }) {
  const verdict = report.verdict;

  // A run that failed before reaching a verdict — honest, not a fabricated call.
  if (!verdict) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {report.status === "failed"
            ? `Qualification failed${report.error ? `: ${report.error}` : "."}`
            : "No verdict was recorded for this run."}
        </p>
        {report.companyId ? <HandOff companyId={report.companyId} transitioned={false} /> : null}
      </div>
    );
  }

  const known = verdict.criteria.filter((c) => c.known).length;
  const transitioned = report.summary?.transitioned ?? false;
  const move =
    transitioned && verdict.recommendedStatus
      ? `→ ${verdict.recommendedStatus}`
      : verdict.recommendedStatus
        ? "No move"
        : "Held";

  return (
    <div className="space-y-6">
      {/* Headline: verdict dial + the figures behind it */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <VerdictDial
            decision={verdict.decision}
            score={verdict.score}
            tierLabel={SCORE_BAND_LABELS[verdict.tier]}
            confidence={verdict.confidence}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2">
          <Tile label="Fit score" value={verdict.score == null ? "—" : `${verdict.score}`} />
          <Tile label="Confidence" value={`${verdict.confidence}%`} sub="on evidence" />
          <Tile label="Criteria evidenced" value={`${known}/${verdict.criteria.length}`} />
          <Tile label="Pipeline" value={move} accent />
        </div>
      </div>

      {/* One-line summary of the call. */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <DecisionBadge decision={verdict.decision} />
        <p className="min-w-0 flex-1 text-sm text-slate-300">{verdict.summary}</p>
      </div>

      {/* Why this verdict — the ordered rationale (the audit trail of the call). */}
      {verdict.rationale.length ? (
        <Panel
          title="Why this verdict"
          subtitle="The decisive rule first, then the supporting signals — reconstructable, never opaque"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
              <ScrollText className="h-3.5 w-3.5" aria-hidden />
              Rationale
            </span>
          }
        >
          <ol className="space-y-2">
            {verdict.rationale.map((line, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-slate-300">
                <span className="mt-0.5 select-none text-xs font-semibold text-slate-600">
                  {i + 1}.
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {/* The criteria — the weighted, transparent model made visible. */}
      <Panel
        title="The five criteria"
        subtitle="Each criterion, its weight, its evidenced value, and whether the gate was met — scored on known signals only"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
            <Target className="h-3.5 w-3.5" aria-hidden />
            Weighted rubric
          </span>
        }
      >
        <div className="divide-y divide-slate-800/70">
          {verdict.criteria.map((c) => (
            <CriterionRow key={c.key} criterion={c} />
          ))}
        </div>
      </Panel>

      {/* What the verdict means for the pipeline. */}
      <Panel
        title="Pipeline outcome"
        subtitle="A qualify / disqualify call only ever moves a lead OUT of 'new' — review holds it for a human"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
            <ListChecks className="h-3.5 w-3.5" aria-hidden />
            Outcome
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-400">Decision</span>
          <DecisionBadge decision={verdict.decision} size="sm" />
          <ArrowRight className="h-4 w-4 text-slate-600" aria-hidden />
          {transitioned && verdict.recommendedStatus ? (
            <span className="font-medium text-emerald-300">
              {decisionLabel(verdict.decision)} — moved to &lsquo;{verdict.recommendedStatus}&rsquo;
            </span>
          ) : verdict.recommendedStatus ? (
            <span className="font-medium text-slate-300">
              Recommended &lsquo;{verdict.recommendedStatus}&rsquo; — status was already past
              &lsquo;new&rsquo;, so nothing moved
            </span>
          ) : (
            <span className="font-medium text-amber-300">
              Held at &lsquo;new&rsquo; for a human to decide
            </span>
          )}
        </div>
      </Panel>

      {/* Hand-off */}
      {report.companyId ? <HandOff companyId={report.companyId} transitioned={transitioned} /> : null}
    </div>
  );
}

function HandOff({
  companyId,
  transitioned,
}: {
  companyId: string;
  transitioned: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
        {transitioned
          ? "Verdict recorded on the company timeline and the pipeline status updated — fully audited."
          : "Verdict recorded on the company timeline — fully audited."}
      </div>
      <Link
        href={`/admin/sales/companies/${companyId}`}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
      >
        Open in Sales AI →
      </Link>
    </div>
  );
}
