import { Suspense } from "react";
import { Cog, Sparkles, Activity, Bell } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadOperationsBoard } from "@/server/services/hq-operations";
import {
  OPERATIONS_KIND_LABEL,
  type OperationsBoard,
  type OperationsFormat,
  type OperationsMetric,
  type OperationsMetricKind,
  type OperationsStatus,
} from "@/lib/hq/operations";

/**
 * CrewFlow HQ — Operations AI (super-admin surface).
 *
 * The platform operations-health picture, honest by construction. Every card
 * carries a label badge (Fact / Derived / Insufficient data) and a one-line
 * basis; signals with no source in the schema — SLA telemetry, a cross-tenant
 * estate-throughput rollup — render as "Insufficient data" with the reason,
 * never a fabricated number.
 *
 * The operations narrative is DARK: it populates only once a model tier is bound
 * behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<OperationsMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

const STATUS_STYLE: Record<OperationsStatus, { pill: string; label: string }> = {
  green: { pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30", label: "All systems nominal" },
  amber: { pill: "bg-amber-500/10 text-amber-300 ring-amber-400/30", label: "Degrading" },
  red: { pill: "bg-red-500/10 text-red-300 ring-red-400/30", label: "Critical" },
};

function formatOps(value: number | null, format: OperationsFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "pct":
      return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    case "days":
      return `${Math.round(value).toLocaleString("en-GB")}d`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function OperationsAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(129,140,248,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
          <Cog className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">Operations AI</h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The platform operations-health picture — every figure labelled Fact,
            Derived, or Insufficient data, with the basis stated. Nothing is
            fabricated: signals with no source in the schema (SLA telemetry,
            cross-tenant throughput) say so rather than inventing a number.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadOperationsBoard();
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SystemHealthPanel systemHealth={board.systemHealth} />
        <AlertLoadPanel alertLoad={board.alertLoad} />
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

function SystemHealthPanel({
  systemHealth,
}: {
  systemHealth: OperationsBoard["systemHealth"];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">System health</h2>
      </div>
      {systemHealth == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The system-health snapshot could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${STATUS_STYLE[systemHealth.status].pill}`}
          >
            {STATUS_STYLE[systemHealth.status].label}
          </span>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-300">
            {systemHealth.summary}
          </p>
          {systemHealth.reasons.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {systemHealth.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-slate-400">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-600" aria-hidden />
                  {r}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-slate-600">
            From the /admin/ops snapshot: cron telemetry (7-day window), the email
            queue, and required-env presence.
          </p>
        </div>
      )}
    </section>
  );
}

function AlertLoadPanel({
  alertLoad,
}: {
  alertLoad: OperationsBoard["alertLoad"];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Bell className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Alert load</h2>
      </div>
      {alertLoad == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The HQ alerts source could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex flex-wrap gap-2">
            <SeverityPill label="Critical" count={alertLoad.critical} tone="red" />
            <SeverityPill label="Warning" count={alertLoad.warning} tone="amber" />
            <SeverityPill label="Info" count={alertLoad.info} tone="blue" />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
            {alertLoad.total === 0
              ? "No open alerts across the estate right now."
              : `${alertLoad.critical + alertLoad.warning} of ${alertLoad.total} open alert${alertLoad.total === 1 ? "" : "s"} need attention.`}
            {alertLoad.oldestAgeDays != null &&
              ` Oldest has been open ${alertLoad.oldestAgeDays} day${alertLoad.oldestAgeDays === 1 ? "" : "s"}.`}
          </p>
          <p className="mt-3 text-[11px] text-slate-600">
            From the deterministic HQ alerts rules engine; resolved and snoozed
            alerts are excluded.
          </p>
        </div>
      )}
    </section>
  );
}

function SeverityPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "red" | "amber" | "blue";
}) {
  const pill =
    tone === "red"
      ? "bg-red-500/10 text-red-300 ring-red-400/30"
      : tone === "amber"
        ? "bg-amber-500/10 text-amber-300 ring-amber-400/30"
        : "bg-blue-500/10 text-blue-300 ring-blue-400/30";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${pill}`}
    >
      <span className="tabular-nums">{count}</span>
      {label}
    </span>
  );
}

function MetricGrid({ board }: { board: OperationsBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Operations metrics</h2>
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

function MetricCard({ metric }: { metric: OperationsMetric }) {
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
        {formatOps(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: OperationsMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {OPERATIONS_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">Operations narrative</h2>
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
              Operations narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of platform operations health runs behind
              the AI governor. It stays dark — and this board stays fully honest
              on the deterministic figures above — until a model tier is armed for
              it. No governor registry key is added for it yet, because an unwired
              key is a permission granted to nothing.
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
          {Array.from({ length: 13 }).map((_, i) => (
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
