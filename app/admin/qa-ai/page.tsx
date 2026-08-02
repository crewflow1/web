import { Suspense } from "react";
import { FlaskConical, Sparkles, ShieldCheck, MessageSquareText } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadQaBoard } from "@/server/services/hq-qa";
import {
  QA_KIND_LABEL,
  type QaBoard,
  type QaFormat,
  type QaMetric,
  type QaMetricKind,
} from "@/lib/hq/qa";
import type { HealthCard, HealthLevel } from "@/lib/hq/boardroom-cards";

/**
 * CrewFlow HQ — QA AI (super-admin surface).
 *
 * The AI-quality & reliability picture, honest by construction. Every card
 * carries a label badge (Fact / Derived / Insufficient data) and a one-line
 * basis; signals with no source in the schema — browser / regression / a11y test
 * results, release approval — render as "Insufficient data" with the reason,
 * never a fabricated pass rate.
 *
 * The QA narrative is DARK: it populates only once a model tier is bound behind
 * the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<QaMetricKind, string> = {
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

function formatQa(value: number | null, format: QaFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function QaAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(45,212,191,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(129,140,248,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300 ring-1 ring-inset ring-teal-400/30">
          <FlaskConical className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">QA AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The AI-quality &amp; reliability picture — every figure labelled Fact,
            Derived, or Insufficient data, with the basis stated. Nothing is
            fabricated: signals with no source in the schema (browser, regression,
            a11y test results, release approval) say so rather than inventing a
            pass rate.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadQaBoard();
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ReliabilityPanel health={board.reliabilityHealth} />
        <ReplyQualityPanel replyQuality={board.replyQuality} />
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

function ReplyQualityPanel({
  replyQuality,
}: {
  replyQuality: QaBoard["replyQuality"];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">AI-reply verdicts</h2>
      </div>
      {replyQuality == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The AI-reply audit ledger could not be read this cycle.
        </div>
      ) : replyQuality.total === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          No AI-drafted replies have been audited yet — an empty ledger, honestly
          zero.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <VerdictStat
              label="Accepted"
              sublabel="allow"
              value={replyQuality.allow}
              total={replyQuality.total}
              tone="text-emerald-300"
            />
            <VerdictStat
              label="Held"
              sublabel="review"
              value={replyQuality.review}
              total={replyQuality.total}
              tone="text-amber-300"
            />
            <VerdictStat
              label="Refused"
              sublabel="block"
              value={replyQuality.block}
              total={replyQuality.total}
              tone="text-red-300"
            />
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            One guardrail verdict per audited reply (ai_reply_audits):{" "}
            {replyQuality.total.toLocaleString("en-GB")} in the recent window.
          </p>
        </div>
      )}
    </section>
  );
}

function VerdictStat({
  label,
  sublabel,
  value,
  total,
  tone,
}: {
  label: string;
  sublabel: string;
  value: number;
  total: number;
  tone: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  return (
    <div>
      <p className={`text-2xl font-bold tabular-nums ${tone}`}>
        {value.toLocaleString("en-GB")}
      </p>
      <p className="mt-1 text-[11px] font-semibold text-slate-300">{label}</p>
      <p className="text-[10px] uppercase tracking-wide text-slate-600">
        {sublabel} · {pct}%
      </p>
    </div>
  );
}

function MetricGrid({ board }: { board: QaBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">AI-quality metrics</h2>
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

function MetricCard({ metric }: { metric: QaMetric }) {
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
          insufficient ? "text-slate-600" : "text-teal-300"
        }`}
      >
        {formatQa(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: QaMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {QA_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">QA narrative</h2>
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
              QA narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of AI-quality &amp; reliability runs behind
              the AI governor. It stays dark — and this board stays fully honest on
              the deterministic figures above — until a model tier is armed for it.
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
