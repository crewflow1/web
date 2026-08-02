import { Suspense } from "react";
import { Megaphone, Sparkles, Filter, Radio } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadMarketingBoard } from "@/server/services/hq-marketing";
import {
  MARKETING_KIND_LABEL,
  type MarketingBoard,
  type MarketingFormat,
  type MarketingMetric,
  type MarketingMetricKind,
} from "@/lib/hq/marketing";

/**
 * CrewFlow HQ — Marketing AI (super-admin surface).
 *
 * The platform acquisition / top-of-funnel picture, honest by construction.
 * Every card carries a label badge (Fact / Derived / Insufficient data) and a
 * one-line basis; signals with no source in the schema — marketing channel
 * attribution, campaign performance, ad spend / CAC, SEO rankings — render as
 * "Insufficient data" with the reason, never a fabricated number.
 *
 * Scope is ACQUISITION, not adoption: demo-request volume, lead sources, the
 * demo → trial → paid funnel, trial→paid conversion, and customer growth. Usage
 * and activation belong to the Product AI.
 *
 * The marketing narrative is DARK: it populates only once a model tier is bound
 * behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<MarketingMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

function formatMkt(value: number | null, format: MarketingFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function MarketingAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(236,72,153,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(129,140,248,0.14), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-pink-500/15 text-pink-300 ring-1 ring-inset ring-pink-400/30">
          <Megaphone className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">Marketing AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The platform acquisition picture — demo-request volume, lead sources,
            the demo → trial → paid funnel and customer growth. Every figure is
            labelled Fact, Derived, or Insufficient data, with the basis stated.
            Signals with no source in the schema (channel attribution, campaigns,
            ad spend, SEO rankings) say so rather than inventing a number.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadMarketingBoard();
  return (
    <>
      <FunnelPanel funnel={board.funnel} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SourcesPanel sources={board.sources} />
        <div className="hidden lg:block" aria-hidden />
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

function FunnelPanel({ funnel }: { funnel: MarketingBoard["funnel"] }) {
  const max = funnel.reduce((m, s) => Math.max(m, s.value), 0);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Filter className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Acquisition funnel</h2>
      </div>
      {funnel.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          Neither the demo-request nor the analytics source could be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="space-y-2.5">
            {funnel.map((stage) => {
              const pct = max > 0 ? Math.max(4, (stage.value / max) * 100) : 4;
              return (
                <div key={stage.key} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-[12px] text-slate-400">
                    {stage.label}
                  </span>
                  <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-slate-800/60">
                    <div
                      className="h-full rounded-md bg-gradient-to-r from-pink-500/60 to-indigo-500/60"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold tabular-nums text-white">
                      {stage.value.toLocaleString("en-GB")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            Demo requests come from CrewFlow&apos;s marketing-site capture; trials and
            active customers from the organisations table. These are stage counts
            from separate tables with no per-lead linkage — not a single cohort
            flowing through.
          </p>
        </div>
      )}
    </section>
  );
}

function SourcesPanel({ sources }: { sources: MarketingBoard["sources"] }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Radio className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Lead sources</h2>
      </div>
      {sources == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The demo-request source could not be read this cycle.
        </div>
      ) : sources.breakdown.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-500">
          No demo requests captured yet.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <ul className="space-y-2">
            {sources.breakdown.map((s) => (
              <li
                key={s.source}
                className="flex items-center justify-between gap-3 text-[12px]"
              >
                <span className="text-slate-300">{s.label}</span>
                <span className="tabular-nums text-slate-400">
                  {s.total.toLocaleString("en-GB")}
                  <span className="ml-1 text-slate-600">
                    ({s.new30d.toLocaleString("en-GB")} in 30d)
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-slate-600">
            The raw distribution of the stored{" "}
            <code className="text-slate-500">demo_requests.source</code> tag — a
            form-origin marker, not marketing channel attribution (see the
            Marketing channel attribution card below).
          </p>
        </div>
      )}
    </section>
  );
}

function MetricGrid({ board }: { board: MarketingBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Marketing metrics</h2>
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

function MetricCard({ metric }: { metric: MarketingMetric }) {
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
          insufficient ? "text-slate-600" : "text-pink-300"
        }`}
      >
        {formatMkt(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: MarketingMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {MARKETING_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Marketing narrative</h2>
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
              Marketing narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of platform acquisition runs behind the AI
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
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-6 w-full animate-pulse rounded-md bg-slate-800" />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 14 }).map((_, i) => (
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
