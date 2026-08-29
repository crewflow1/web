import { Suspense } from "react";
import { Wrench, Sparkles, ShieldCheck, AlertTriangle } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { queuePrReview } from "./actions";
import { loadCtoBoard } from "@/server/services/hq-cto";
import {
  CTO_KIND_LABEL,
  type CtoBoard,
  type CtoFormat,
  type CtoMetric,
  type CtoMetricKind,
} from "@/lib/hq/cto";
import type { HealthCard, HealthLevel } from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — CTO AI (super-admin surface).
 *
 * The platform / engineering-health picture, honest by construction. Every card
 * carries a label badge (Fact / Derived / Insufficient data) and a one-line
 * basis; signals with no source in the schema — CI runs, deploy history, uptime
 * telemetry — render as "Insufficient data" with the reason, never a fabricated
 * number.
 *
 * The technical narrative is DARK: it populates only once a model tier is bound
 * behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<CtoMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

const HEALTH_STYLE: Record<HealthLevel, { pill: string; label: string }> = {
  green: { pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30", label: "Healthy" },
  amber: { pill: "bg-amber-500/10 text-amber-300 ring-amber-400/30", label: "Degrading" },
  red: { pill: "bg-red-500/10 text-red-300 ring-red-400/30", label: "Critical" },
  insufficient: { pill: "bg-slate-700/40 text-slate-400 ring-slate-600/40", label: "Insufficient data" },
};

function formatCto(value: number | null, format: CtoFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "gbp":
      return `£${Math.round(value).toLocaleString("en-GB")}`;
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

type SP = Promise<{ saved?: string; error?: string }>;

/** Outcome CODES from the queue-PR-review action — exact-match allowlist. */
const PR_REVIEW_OUTCOME_COPY: Record<string, { tone: "ok" | "err"; text: string }> = {
  pr_review_queued: {
    tone: "ok",
    text: "PR review task queued and drained — the result appears in the CTO AI task feed.",
  },
  invalid_pr_number: { tone: "err", text: "Enter a valid PR number (a positive whole number)." },
  pr_review_enqueue_failed: { tone: "err", text: "Could not queue that review — try again." },
  pr_review_no_cto_ai: {
    tone: "err",
    text: "No CTO AI identity is seeded, so nothing can run the review.",
  },
};

export default async function CtoAiPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;
  const outcome =
    PR_REVIEW_OUTCOME_COPY[sp.saved ?? ""] ?? PR_REVIEW_OUTCOME_COPY[sp.error ?? ""] ?? null;
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header />
      <div className="space-y-8 p-5 sm:p-7">
        {outcome ? (
          <p
            role="status"
            className={
              outcome.tone === "ok"
                ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-300"
                : "rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300"
            }
          >
            {outcome.text}
          </p>
        ) : null}
        <QueuePrReviewForm />
        <Suspense fallback={<BoardSkeleton />}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The production door for cto_pr_review (L9a, P7) — event-shaped, so it is
 * queued here rather than by the roster-workers tick. Dark-honest: with no
 * GitHub credential bound the adapter refuses before fetch and the task
 * completes with its documented dark outcome.
 */
function QueuePrReviewForm() {
  return (
    <form
      action={queuePrReview}
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <div>
        <label htmlFor="cto-pr-number" className="block text-xs font-medium text-slate-400">
          Queue a PR review
        </label>
        <input
          id="cto-pr-number"
          name="pr_number"
          type="number"
          min={1}
          step={1}
          required
          placeholder="PR number"
          className="mt-1 w-36 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
        />
      </div>
      <button
        type="submit"
        className="rounded-md bg-indigo-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
      >
        Queue review
      </button>
      <p className="basis-full text-xs text-slate-500 sm:basis-auto sm:pl-2">
        Runs through the Task Engine as CTO AI; the diff fetch stays dark until a
        GitHub credential is bound, and the task records that honestly.
      </p>
    </form>
  );
}

function Header() {
  return (
    <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 120% at 15% 0%, rgba(129,140,248,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
          <Wrench className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">CTO AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The platform &amp; engineering-health picture — every figure labelled
            Fact, Derived, or Insufficient data, with the basis stated. Nothing is
            fabricated: signals with no source in the schema (CI, deploys, uptime)
            say so rather than inventing a number.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadCtoBoard();
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ReliabilityPanel health={board.reliabilityHealth} />
        <LaunchPanel launch={board.launch} />
      </div>
      <MetricGrid board={board} />
      <NarrativePanel narrative={narrative} />
      <p className="text-center text-[11px] text-slate-600">
        {board.periodLabel} · generated{" "}
        {new Date(generatedAt).toLocaleString("en-GB")} · every figure sourced
        from HQ read models or marked insufficient
      </p>
    </>
  );
}

function ReliabilityPanel({ health }: { health: HealthCard | null }) {
  const level: HealthLevel = health?.level ?? "insufficient";
  const style = HEALTH_STYLE[level];
  const reasons = health?.reasons ?? [
    "The AI task queue could not be read this cycle, so reliability cannot be assessed.",
  ];
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Reliability health</h2>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${style.pill}`}
        >
          {style.label}
        </span>
        <ul className="mt-3 space-y-1.5">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-slate-400">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-600" aria-hidden />
              {r}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-slate-600">
          Derived from the recent hq_ai_tasks window: stalled leases, stale
          heartbeats, retry pressure, and the finished-task failure ratio.
        </p>
      </div>
    </section>
  );
}

function LaunchPanel({
  launch,
}: {
  launch: CtoBoard["launch"];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Launch readiness</h2>
      </div>
      {launch == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The launch-readiness source could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${
              launch.overall === "green"
                ? HEALTH_STYLE.green.pill
                : launch.overall === "amber"
                  ? HEALTH_STYLE.amber.pill
                  : HEALTH_STYLE.red.pill
            }`}
          >
            {launch.overall === "green"
              ? "Ready"
              : launch.overall === "amber"
                ? "Warnings"
                : "Blocked"}
          </span>
          {launch.blockers.length === 0 ? (
            <p className="mt-3 text-[12px] text-slate-400">
              No red checklist rows — nothing is blocking launch.
            </p>
          ) : (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-red-300/80">
                Blockers
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {launch.blockers.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-slate-300">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-red-400" aria-hidden />
                    {b}
                  </li>
                ))}
              </ul>
            </>
          )}
          {launch.warnings.length > 0 && (
            <p className="mt-3 text-[11px] text-slate-600">
              {launch.warnings.length} warning
              {launch.warnings.length === 1 ? "" : "s"} (do not block launch).
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function MetricGrid({ board }: { board: CtoBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Engineering metrics</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Deterministic figures for {board.periodLabel} — each card states exactly
          how it is (or cannot be) computed
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {board.metrics.map((m) => (
          <MetricCard key={m.key} metric={m} />
        ))}
      </div>
    </section>
  );
}

function MetricCard({ metric }: { metric: CtoMetric }) {
  const insufficient = metric.kind === "insufficient";
  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden rounded-xl border p-4 shadow-lg ring-1 ring-inset ring-white/5 ${
        insufficient
          ? "border-slate-800 bg-slate-900/30"
          : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {metric.label}
        </p>
        <KindBadge kind={metric.kind} />
      </div>
      <p
        className={`mt-2 text-2xl font-bold tabular-nums ${
          insufficient ? "text-slate-600" : "text-indigo-300"
        }`}
      >
        {formatCto(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: CtoMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {CTO_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Technical narrative</h2>
      </div>
      {narrative ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-relaxed text-slate-300">
          {narrative}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/60 text-slate-400 ring-1 ring-inset ring-slate-700/50">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-slate-300">
              Technical narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of platform &amp; engineering health runs
              behind the AI governor. It stays dark — and this board stays fully
              honest on the deterministic figures above — until a model tier is
              armed for it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="h-5 w-24 animate-pulse rounded-full bg-slate-800" />
            <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-800" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <div className="flex items-center justify-between">
                <div className="h-3 w-16 animate-pulse rounded bg-slate-800" />
                <div className="h-4 w-14 animate-pulse rounded-full bg-slate-800" />
              </div>
              <div className="mt-3 h-7 w-24 animate-pulse rounded bg-slate-800" />
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
