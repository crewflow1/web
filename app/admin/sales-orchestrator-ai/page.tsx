import { Suspense } from "react";
import { Workflow, Sparkles, GitBranch, Gauge } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadSalesOrchestratorBoard } from "@/server/services/hq-sales-orchestrator";
import {
  SALES_ORCHESTRATOR_KIND_LABEL,
  type SalesOrchestratorBoard,
  type SalesOrchestratorFormat,
  type SalesOrchestratorMetric,
  type SalesOrchestratorMetricKind,
} from "@/lib/hq/sales-orchestrator";

/**
 * CrewFlow HQ — Sales-Orchestrator AI (super-admin surface).
 *
 * ONE cross-stage pipeline board that unifies the three sales drains — Research,
 * Qualification and Outreach — into a single pipeline-health / deal-progression
 * view. Honest by construction: every card carries a label badge (Fact / Derived
 * / Insufficient data) and a one-line basis. A count that reads as zero is a
 * fact; a ratio or age with no base is "Insufficient data" (undefined, not
 * zero); a source that could not be read this cycle is insufficient too. Signals
 * with no schema source — cohort deal velocity, forecast win probability —
 * render as "Insufficient data" with the reason, never a fabricated number.
 *
 * The orchestrator narrative is DARK: it populates only once a model tier is
 * bound behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<SalesOrchestratorMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

function formatMetric(
  value: number | null,
  format: SalesOrchestratorFormat,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "days":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}d`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function SalesOrchestratorAiPage() {
  await requireHqPage();
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header />
      <div className="space-y-8 p-5 sm:p-7">
        <Suspense fallback={<BoardSkeleton />}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(56,189,248,0.14), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
          <Workflow className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            Sales-Orchestrator AI
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-400">
            One pipeline across the three sales drains — Research, Qualification
            and Outreach — unified into stage counts, stage-to-stage conversion,
            drain backlog health and outreach cadence. Every figure is labelled
            Fact, Derived, or Insufficient data, with the basis stated. A readable
            zero is a fact; a ratio with no base, and any signal with no schema
            source (cohort velocity, forecast win probability), say so rather than
            inventing a number.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadSalesOrchestratorBoard();
  return (
    <>
      <FunnelPanel funnel={board.funnel} />
      <DrainsPanel drains={board.drains} />
      <MetricGrid board={board} />
      <NarrativePanel narrative={narrative} />
      <p className="text-center text-[11px] text-slate-600">
        {board.periodLabel} · generated{" "}
        {new Date(generatedAt).toLocaleString("en-GB")} · every figure sourced
        from HQ sales read models or marked insufficient
      </p>
    </>
  );
}

function FunnelPanel({ funnel }: { funnel: SalesOrchestratorBoard["funnel"] }) {
  const max = funnel.reduce((m, s) => Math.max(m, s.reached), 0);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Unified pipeline</h2>
      </div>
      {funnel.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The sales pipeline source could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="space-y-2.5">
            {funnel.map((stage) => {
              const pct = max > 0 ? Math.max(4, (stage.reached / max) * 100) : 4;
              return (
                <div key={stage.key} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 text-[12px] text-slate-400">
                    {stage.label}
                  </span>
                  <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-slate-800/60">
                    <div
                      className="h-full rounded-md bg-gradient-to-r from-indigo-500/60 to-sky-500/60"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold tabular-nums text-white">
                      {stage.reached.toLocaleString("en-GB")}
                    </span>
                  </div>
                  <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                    {stage.conversionFromPrev == null
                      ? "—"
                      : `${stage.conversionFromPrev.toLocaleString("en-GB", {
                          maximumFractionDigits: 1,
                        })}%`}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            Deals that have reached each stage or beyond, from CrewFlow&apos;s own
            sales pipeline — a point-in-time position snapshot, not a cohort
            flowing through. The right-hand figure is conversion from the previous
            stage.
          </p>
        </div>
      )}
    </section>
  );
}

function DrainsPanel({ drains }: { drains: SalesOrchestratorBoard["drains"] }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Drain health</h2>
      </div>
      {drains == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The HQ task queue could not be read this cycle.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {drains.map((d) => (
            <div
              key={d.key}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {d.label}
              </p>
              <dl className="mt-2 space-y-1 text-[12px]">
                <Row label="Backlog" value={d.backlog} />
                <Row label="In flight" value={d.inFlight} />
                <Row label="Completed" value={d.completed} />
                <Row label="Failed" value={d.failed} danger={d.failed > 0} />
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd
        className={`tabular-nums ${danger ? "text-amber-300" : "text-slate-300"}`}
      >
        {value.toLocaleString("en-GB")}
      </dd>
    </div>
  );
}

function MetricGrid({ board }: { board: SalesOrchestratorBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Pipeline metrics</h2>
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

function MetricCard({ metric }: { metric: SalesOrchestratorMetric }) {
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
        {formatMetric(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: SalesOrchestratorMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {SALES_ORCHESTRATOR_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">
          Pipeline narrative
        </h2>
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
              Pipeline narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of pipeline health runs behind the AI
              governor. It stays dark — and this board stays fully honest on the
              deterministic figures above — until a model tier is armed for it. No
              governor registry key is added for it yet, because an unwired key is
              a permission granted to nothing.
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
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="h-5 w-32 animate-pulse rounded-full bg-slate-800" />
        <div className="mt-3 space-y-2.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="h-6 w-full animate-pulse rounded-md bg-slate-800"
            />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 21 }).map((_, i) => (
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
