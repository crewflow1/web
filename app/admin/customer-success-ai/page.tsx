import { Suspense } from "react";
import { HeartHandshake, Sparkles, Filter, Activity } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadCustomerSuccessBoard } from "@/server/services/hq-customer-success";
import {
  CUSTOMER_SUCCESS_KIND_LABEL,
  type CustomerSuccessBoard,
  type CustomerSuccessFormat,
  type CustomerSuccessMetric,
  type CustomerSuccessMetricKind,
} from "@/lib/hq/customer-success";

/**
 * CrewFlow HQ — Customer-Success AI (super-admin surface).
 *
 * The platform retention / adoption picture, honest by construction. Every card
 * carries a label badge (Fact / Derived / Insufficient data) and a one-line
 * basis; signals with no source in the schema — NPS/CSAT, renewal-cohort
 * retention, support satisfaction, time-to-first-value — render as "Insufficient
 * data" with the reason, never a fabricated number.
 *
 * Scope is RETENTION & ADOPTION, not acquisition: post-sale onboarding, trial→
 * paid conversion, 30-day activation, onboarding completion, health segmentation
 * and churn. Demo-request volume, lead sources and channel attribution belong to
 * the Marketing AI.
 *
 * The customer-success narrative is DARK: it populates only once a model tier is
 * bound behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<CustomerSuccessMetricKind, string> = {
  fact: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  derived: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  insufficient: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
};

function formatCs(value: number | null, format: CustomerSuccessFormat): string {
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

export default async function CustomerSuccessAiPage() {
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
            "radial-gradient(60% 120% at 15% 0%, rgba(45,212,191,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(56,189,248,0.14), transparent 55%)",
        }}
        aria-hidden
      />
      <div className="relative flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300 ring-1 ring-inset ring-teal-400/30">
          <HeartHandshake className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            Customer-Success AI
          </h1>
          <p className="mt-0.5 max-w-xl text-sm text-slate-400">
            The platform retention picture — post-sale onboarding, trial→paid
            conversion, 30-day activation, health segmentation and churn. Every
            figure is labelled Fact, Derived, or Insufficient data, with the
            basis stated. Signals with no source in the schema (NPS/CSAT, renewal
            cohort, support satisfaction, time-to-first-value) say so rather than
            inventing a number.
          </p>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadCustomerSuccessBoard();
  return (
    <>
      <OnboardingFunnelPanel funnel={board.onboardingFunnel} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <HealthSegmentsPanel segments={board.healthSegments} />
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

function OnboardingFunnelPanel({
  funnel,
}: {
  funnel: CustomerSuccessBoard["onboardingFunnel"];
}) {
  const max = funnel.reduce((m, s) => Math.max(m, s.value), 0);
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Filter className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Onboarding funnel</h2>
      </div>
      {funnel.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The demo-request lifecycle source could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="space-y-2.5">
            {funnel.map((stage) => {
              const pct = max > 0 ? Math.max(4, (stage.value / max) * 100) : 4;
              return (
                <div key={stage.key} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 text-[12px] text-slate-400">
                    {stage.label}
                  </span>
                  <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-slate-800/60">
                    <div
                      className="h-full rounded-md bg-gradient-to-r from-teal-500/60 to-sky-500/60"
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
            The post-sale stages of CrewFlow&apos;s own demo-request lifecycle —
            paid → onboarding → fully live. Stage counts within one table, a
            point-in-time snapshot, not a cohort flowing through.
          </p>
        </div>
      )}
    </section>
  );
}

function HealthSegmentsPanel({
  segments,
}: {
  segments: CustomerSuccessBoard["healthSegments"];
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-slate-400" aria-hidden />
        <h2 className="text-sm font-semibold text-white">Customer health</h2>
      </div>
      {segments == null ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-4 text-xs text-slate-500">
          The analytics snapshot could not be read this cycle.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <ul className="space-y-2">
            {segments.map((s) => (
              <li
                key={s.key}
                className="flex items-center justify-between gap-3 text-[12px]"
              >
                <span className="text-slate-300">{s.label}</span>
                <span className="tabular-nums text-slate-400">
                  {s.value.toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-slate-600">
            Paying-or-trial organisations by health-score band. Unscored orgs are
            surfaced honestly, never folded into &ldquo;healthy&rdquo;.
          </p>
        </div>
      )}
    </section>
  );
}

function MetricGrid({ board }: { board: CustomerSuccessBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">
          Customer-success metrics
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Deterministic figures for {board.periodLabel} — each card states
          exactly how it is (or cannot be) computed
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

function MetricCard({ metric }: { metric: CustomerSuccessMetric }) {
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
        {formatCs(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        {metric.basis}
      </p>
    </div>
  );
}

function KindBadge({ kind }: { kind: CustomerSuccessMetricKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${KIND_BADGE[kind]}`}
    >
      {CUSTOMER_SUCCESS_KIND_LABEL[kind]}
    </span>
  );
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">
          Customer-success narrative
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
              Customer-success narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of platform retention runs behind the AI
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
          {Array.from({ length: 3 }).map((_, i) => (
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
