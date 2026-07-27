import Link from "next/link";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Filter,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getQualificationMetrics,
  type QualificationRunRow,
} from "@/server/services/hq-qualification";
import { searchCompanies } from "@/server/services/hq-sales";
import { QUALIFICATION_DECISION_LABELS } from "@/lib/qualification/model";
import { scoreBandLabel } from "@/lib/sales/model";
import {
  QualificationLauncher,
  QuickQualifyButton,
  type LauncherCandidate,
} from "./_launcher";
import { Tile, DecisionBadge } from "./_components";
import { STATUS_LABEL, STATUS_PILL, scoreTone } from "./_styles";

/**
 * Lead Qualification AI — section home (CEO Directive 003, Module 3).
 *
 * The one chooser ("Qualify lead") plus the live outcomes of the employee:
 * how many leads it has qualified vs disqualified vs held for review, how many
 * it actually moved along the pipeline, the in-flight queue, and its average
 * confidence. Honest zeros until the first run. The candidate list lets an
 * operator one-click any researched lead still sitting at 'new'; recent runs
 * link straight to their live / finished verdict.
 */

export const dynamic = "force-dynamic";

export default async function QualificationHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, metrics, candidatePage] = await Promise.all([
    searchParams,
    getQualificationMetrics(),
    searchCompanies({ status: "new", sort: "researched", pageSize: 12 }),
  ]);

  const candidates: LauncherCandidate[] = candidatePage.companies.map((c) => ({
    id: c.id,
    name: c.name,
    score: c.ai_qualification_score,
    researched: !!c.last_researched_at,
  }));

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
              <h1 className="text-xl font-bold tracking-tight text-white">
                Lead Qualification AI
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                The deterministic, explainable qualify / disqualify call. It
                reads the fit score Research AI produced and the evidence behind
                it, then moves the right leads forward — and only those.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              No black box · every verdict audited
            </span>
            <Link
              href="/admin/research"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Activity className="h-3.5 w-3.5" aria-hidden />
              Research AI
            </Link>
          </div>
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-7">
        {error ? (
          <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {error}
          </p>
        ) : null}

        {/* The one chooser */}
        <section className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-900/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-300" aria-hidden />
            <h2 className="text-sm font-semibold text-white">Qualify a lead</h2>
          </div>
          <QualificationLauncher candidates={candidates} />
          <p className="mt-4 rounded-lg border border-slate-700/40 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
            The verdict is reconstructable from five named, weighted criteria —
            fit score, evidence depth, territory, sector and decision-maker
            access. There is no model in this path: a qualify / disqualify call
            gates a company&rsquo;s place in the pipeline, so it must be
            explainable, never an opaque sample.
          </p>
        </section>

        {/* Live outcomes */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-slate-400" aria-hidden />
              <h2 className="text-sm font-semibold text-white">Outcomes</h2>
            </div>
            <span className="text-[11px] text-slate-500">
              {metrics.total.toLocaleString()} total
              {metrics.failed ? ` · ${metrics.failed} failed` : ""}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Qualified" value={metrics.qualified.toLocaleString()} accent />
            <Tile label="Disqualified" value={metrics.disqualified.toLocaleString()} />
            <Tile label="Needs review" value={metrics.review.toLocaleString()} sub="held at 'new'" />
            <Tile
              label="Transitioned"
              value={metrics.transitioned.toLocaleString()}
              sub="moved in pipeline"
            />
            <Tile label="In flight" value={metrics.inFlight.toLocaleString()} sub="queued + running" />
            <Tile
              label="Avg confidence"
              value={metrics.avgConfidence == null ? "—" : `${metrics.avgConfidence}%`}
              sub="on evidenced criteria"
            />
          </div>
        </section>

        {/* Candidate leads — one-click qualify */}
        {candidates.length ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">New leads to qualify</h2>
              <span className="text-[11px] text-slate-500">
                {candidatePage.total.toLocaleString()} at &lsquo;new&rsquo;
              </span>
            </div>
            <ul className="divide-y divide-slate-800/70">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/admin/sales/companies/${c.id}`}
                      className="truncate text-sm font-medium text-white transition hover:text-indigo-300"
                    >
                      {c.name}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span className={`font-semibold tabular-nums ${scoreTone(c.score)}`}>
                        {c.score == null ? "Unscored" : `Fit ${c.score} · ${scoreBandLabel(c.score)}`}
                      </span>
                      {!c.researched ? <span className="text-amber-400/80">not researched</span> : null}
                    </p>
                  </div>
                  <QuickQualifyButton companyId={c.id} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Recent runs */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent verdicts</h2>
            {metrics.lastCompletedAt ? (
              <span className="text-[11px] text-slate-500">
                Last completed {relativeTime(metrics.lastCompletedAt)}
              </span>
            ) : null}
          </div>
          {metrics.recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-500">
              No qualifications yet. Choose a lead above and watch the engine
              make the call.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {metrics.recent.map((run) => (
                <RunRow key={run.taskId} run={run} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: QualificationRunRow }) {
  const when = run.finishedAt ?? run.createdAt;
  return (
    <li>
      <Link
        href={`/admin/qualification/${run.taskId}`}
        className="flex items-center justify-between gap-3 py-3 transition hover:opacity-90"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {run.companyName ?? "Untitled company"}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_PILL[run.status]}`}>
              {STATUS_LABEL[run.status]}
            </span>
            {run.confidence != null ? <span>{run.confidence}% confidence</span> : null}
            {run.transitioned ? <span className="text-emerald-400/80">moved</span> : null}
            {when ? <span>{relativeTime(when)}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {run.decision ? (
            <DecisionBadge decision={run.decision} size="sm" />
          ) : (
            <span className="text-[11px] text-slate-500">
              {QUALIFICATION_DECISION_LABELS.review}
            </span>
          )}
          <span className={`text-lg font-bold tabular-nums ${scoreTone(run.score)}`}>
            {run.score == null ? "—" : run.score}
          </span>
        </div>
      </Link>
    </li>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
