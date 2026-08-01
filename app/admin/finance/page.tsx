import { Suspense } from "react";
import { Banknote, Sparkles } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadFinanceBoard } from "@/server/services/hq-finance";
import {
  FINANCE_KIND_LABEL,
  type FinanceBoard,
  type FinanceFormat,
  type FinanceMetric,
  type FinanceMetricKind,
} from "@/lib/hq/finance";

/**
 * CrewFlow HQ — FINANCE AI (super-admin surface).
 *
 * The company's board-level money picture, honest by construction. Every card
 * carries a label badge (Fact / Derived / Insufficient data) and a one-line
 * basis; figures with no source in the schema render as "Insufficient data"
 * with the reason — never a fabricated zero.
 *
 * The board narrative is DARK: it populates only once a model tier is bound
 * behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<FinanceMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

function formatFinance(value: number | null, format: FinanceFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "gbp":
      return `£${Math.round(value).toLocaleString("en-GB")}`;
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "months":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} mo`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function FinanceAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(16,185,129,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(56,189,248,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
          <Banknote className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            Finance AI
          </h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The board money picture — every figure labelled Fact, Derived, or
            Insufficient data, with the basis stated. Nothing is fabricated: a
            metric with no source in the schema says so.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadFinanceBoard();
  return (
    <>
      <MetricGrid board={board} />
      <NarrativePanel narrative={narrative} />
      <p className="text-center text-[11px] text-slate-600">
        {board.periodLabel} · generated{" "}
        {new Date(generatedAt).toLocaleString("en-GB")} · every figure sourced
        from HQ records or marked insufficient
      </p>
    </>
  );
}

function MetricGrid({ board }: { board: FinanceBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Board metrics</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Deterministic figures for {board.periodLabel} — hover the basis to see
          exactly how each one is (or cannot be) computed
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

function MetricCard({ metric }: { metric: FinanceMetric }) {
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
          insufficient ? "text-slate-600" : "text-emerald-300"
        }`}
      >
        {formatFinance(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: FinanceMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {FINANCE_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Board narrative</h2>
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
              Board narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary runs behind the AI governor. It stays dark
              — and this board stays fully honest on the deterministic figures
              above — until a model tier is armed for it.
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
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
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
