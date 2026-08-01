import { Eye, Lock, ShieldOff } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { getExecutorShadowFeed } from "@/server/services/executor-shadow-observations";
import {
  UNKNOWN_GROUP_LABEL,
  type ShadowObservationView,
  type ShadowOutcome,
} from "@/lib/executor-shadow/grouping";
import { relativeTime } from "@/lib/time/relative";

/**
 * Executor Shadow — read-only observability (Train 11).
 *
 * The durable shadow store (hq_ai_executor_shadow_observations) records what the
 * executor WOULD have done had execution been live — planned tool calls, refusals,
 * errors — and until now NOTHING read it. This page is the reader: the evidence
 * base for the CEO's live-execution decision, stated as such on the surface.
 *
 * STRICTLY READ-ONLY: no actions, no forms, no writes — the page renders what the
 * read service SELECTed and nothing else. Execution itself stays LOCKED
 * (shadow-only; Executor.apply/execute are never called anywhere), and this page
 * changes nothing about that.
 *
 * UNTRUSTED CONTENT: plan/refusal payloads derive from model-shaped runs and may
 * carry adversarial text. Everything renders as React-escaped plain text — never
 * dangerouslySetInnerHTML, never interpreted.
 */

export const dynamic = "force-dynamic";

const OUTCOME_PILL: Record<ShadowOutcome, string> = {
  planned: "bg-indigo-100 text-indigo-800 ring-indigo-300",
  refused: "bg-amber-100 text-amber-800 ring-amber-300",
  error: "bg-red-100 text-red-800 ring-red-300",
};

const OUTCOME_LABEL: Record<ShadowOutcome, string> = {
  planned: "Would have executed",
  refused: "Refused by the executor",
  error: "Errored while planning",
};

export default async function ExecutorShadowPage() {
  await requireHqPage();
  const feed = await getExecutorShadowFeed(200);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-slate-100">
            <Eye className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Executor Shadow
            </h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
              What the executor <em>would have done</em>, had execution been live.
              Nothing here ran — every row is an observation, never an effect.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300">
          <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Shadow mode · execution locked
        </span>
      </header>

      <p className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm text-indigo-900">
        <Lock className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        This record is the evidence base for the CEO&apos;s live-execution
        decision: it shows exactly what would change if the executor were
        switched on. Until that decision is made, apply/execute are never called.
      </p>

      {/* Headline outcome totals over the recent window */}
      <div className="grid grid-cols-3 gap-3">
        {(Object.keys(OUTCOME_LABEL) as ShadowOutcome[]).map((o) => (
          <div
            key={o}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              {OUTCOME_LABEL[o]}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {feed.totals[o]}
            </p>
          </div>
        ))}
      </div>

      {/* Per employee / task-type groups */}
      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          By employee & task type (recent {feed.observations.length} observations)
        </h2>
        {feed.groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <p className="text-sm text-slate-500">
              No shadow observations recorded yet. Rows appear here once the
              shadow flag is on and autonomous runs are being observed.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {feed.groups.map((g) => (
              <div
                key={g.key}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <p className="truncate text-sm font-semibold text-slate-900">
                  {g.employeeName === UNKNOWN_GROUP_LABEL
                    ? "Unknown employee"
                    : g.employeeName}
                </p>
                <p className="truncate font-mono text-xs text-slate-500">{g.taskType}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <OutcomeChip outcome="planned" count={g.outcomes.planned} />
                  <OutcomeChip outcome="refused" count={g.outcomes.refused} />
                  <OutcomeChip outcome="error" count={g.outcomes.error} />
                </div>
                <p className="mt-2 text-[11px] text-slate-400">
                  last observed {relativeTime(g.lastObservedAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* The raw feed, newest first */}
      {feed.observations.length > 0 ? (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Recent observations
          </h2>
          <ul className="space-y-2">
            {feed.observations.map((o) => (
              <li key={o.id}>
                <ObservationRow
                  o={o}
                  meta={feed.metaByTaskId.get(o.taskId) ?? null}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OutcomeChip({ outcome, count }: { outcome: ShadowOutcome; count: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${OUTCOME_PILL[outcome]} ${count === 0 ? "opacity-40" : ""}`}
    >
      {outcome} <span className="font-bold tabular-nums">{count}</span>
    </span>
  );
}

/**
 * One shadow fact, rendered inert: tool + key + reason/detail are plain
 * React-escaped text (the detail block is the plan/refusal payload — untrusted).
 */
function ObservationRow({
  o,
  meta,
}: {
  o: ShadowObservationView;
  meta: { taskType: string; employeeName: string | null } | null;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${OUTCOME_PILL[o.outcome]}`}
        >
          {o.outcome}
        </span>
        <span className="font-medium text-slate-800">
          {meta?.employeeName ?? "Unknown employee"}
        </span>
        <span className="font-mono text-slate-500">{meta?.taskType ?? "unknown"}</span>
        <span className="ml-auto text-[11px] text-slate-400">
          {relativeTime(o.observedAt)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="inline text-slate-400">action </dt>
          <dd className="inline break-all font-mono text-slate-700">{o.actionId}</dd>
        </div>
        {o.toolLabel ? (
          <div className="min-w-0">
            <dt className="inline text-slate-400">would call </dt>
            <dd className="inline break-all font-mono text-slate-700">{o.toolLabel}</dd>
          </div>
        ) : null}
        {o.idempotencyKey ? (
          <div className="min-w-0">
            <dt className="inline text-slate-400">apply key </dt>
            <dd className="inline break-all font-mono text-slate-500">
              {o.idempotencyKey}
            </dd>
          </div>
        ) : null}
        {o.reason ? (
          <div className="min-w-0">
            <dt className="inline text-slate-400">refusal </dt>
            <dd className="inline text-slate-700">{o.reason}</dd>
          </div>
        ) : null}
      </dl>
      {o.detail ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-relaxed text-slate-700">
          {o.detail}
        </pre>
      ) : null}
    </article>
  );
}
