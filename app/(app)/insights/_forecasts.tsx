import Link from "next/link";
import type { ReactNode } from "react";
import { formatGbp } from "@/lib/money";
import { formatDateShortUK } from "@/lib/time/format";
import {
  SIGNAL_KIND_DESCRIPTION,
  SIGNAL_KIND_LABEL,
  type SignalKind,
  type SignalProvenance,
} from "@/lib/intelligence/provenance";
import { cashTimelineMetric } from "@/lib/intelligence/cash-timeline";
import { labourForecastMetric } from "@/lib/intelligence/labour-forecast";
import { delayRiskMetric, DELAY_FACTOR_LABEL } from "@/lib/intelligence/delay-risk";
import {
  commercialRiskMetric,
  COMMERCIAL_RISK_BAND_LABEL,
  type CommercialRiskBand,
} from "@/lib/intelligence/commercial-risk";
import {
  customerLtvForecastMetric,
  CHURN_BAND_LABEL,
  type ChurnBand,
} from "@/lib/health/customer-ltv-forecast";
import type { ForecastsView } from "@/server/services/forecasting";

/**
 * FORECASTS — the deterministic FORWARD section of /insights.
 *
 * Companion to Company signals (which is point-in-time): this section projects
 * cash and labour over the coming weeks and boards the recorded delivery and
 * commercial risks. Every card labels itself and shows its derivation; a failed
 * read renders an explicit error block, never an empty figure; absent data reads
 * "not enough data", never a reassuring zero. No AI anywhere.
 *
 * The section renders only for a role that can see the cash outflow side — the
 * page gates it — so the cash timeline is never drawn with half a ledger.
 */

// ---------------------------------------------------------------------------
// Building blocks (local, matching _company-signals.tsx)
// ---------------------------------------------------------------------------

const KIND_BADGE_CLASS: Record<SignalKind, string> = {
  fact: "bg-slate-100 text-slate-700 border-slate-200",
  derived: "bg-sky-50 text-sky-800 border-sky-200",
  heuristic: "bg-amber-50 text-amber-800 border-amber-200",
};

function KindBadge({ kind }: { kind: SignalKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${KIND_BADGE_CLASS[kind]}`}
      title={SIGNAL_KIND_DESCRIPTION[kind]}
    >
      {SIGNAL_KIND_LABEL[kind]}
    </span>
  );
}

function ProvenanceFooter({ provenance }: { provenance: SignalProvenance }) {
  return (
    <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
      <p className="text-xs leading-relaxed text-slate-500">{provenance.basis}</p>
      <p className="text-xs text-slate-400">
        Computed from:{" "}
        {provenance.computedFrom.map((ref, i) => (
          <span key={`${ref.href}-${i}`}>
            {i > 0 ? " · " : ""}
            <Link href={ref.href} className="underline decoration-slate-300 hover:text-slate-600">
              {ref.label}
            </Link>
          </span>
        ))}
      </p>
    </div>
  );
}

function SignalCard({
  title,
  kind,
  children,
  provenance,
}: {
  title: string;
  kind: SignalKind;
  children: ReactNode;
  provenance: SignalProvenance;
}) {
  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <KindBadge kind={kind} />
      </header>
      <div className="mt-3">{children}</div>
      <ProvenanceFooter provenance={provenance} />
    </article>
  );
}

function GroupError({ what }: { what: string }) {
  return (
    <article
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-rose-900 sm:p-5"
    >
      <p className="font-medium">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-xs">
        The read failed, so nothing is shown — a blank forecast here would be a claim, and a wrong
        one. Reload the page; if it persists, it has already been reported.
      </p>
    </article>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate text-lg font-semibold text-slate-900">{value}</dd>
      {sub ? <dd className="text-xs text-slate-500">{sub}</dd> : null}
    </div>
  );
}

const RISK_BAND_CLASS: Record<CommercialRiskBand, string> = {
  ok: "bg-emerald-50 text-emerald-800 border-emerald-200",
  watch: "bg-amber-50 text-amber-800 border-amber-200",
  high: "bg-rose-50 text-rose-800 border-rose-200",
  insufficient: "bg-slate-100 text-slate-600 border-slate-200",
};

function BandPill({ band }: { band: CommercialRiskBand }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${RISK_BAND_CLASS[band]}`}
    >
      {COMMERCIAL_RISK_BAND_LABEL[band]}
    </span>
  );
}

function weekLabel(startDay: string): string {
  return formatDateShortUK(`${startDay}T12:00:00Z`);
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function ForecastsSection({ view }: { view: ForecastsView }) {
  return (
    <section aria-labelledby="forecasts-heading" className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="forecasts-heading" className="text-lg font-semibold text-slate-900">
            Forecasts
          </h2>
          <p className="text-xs text-slate-500">
            Next {view.horizonWeeks} weeks · from {formatDateShortUK(`${view.todayKey}T12:00:00Z`)}
          </p>
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
          Forward-looking, still deterministic — projected from your own dated records, no model and
          no invented probabilities. Money is placed on the date it is due, scheduled or statutory;
          risks are the recorded signals, each shown with the rule that flagged it.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <CashTimelineCard view={view} />
        <LabourCard view={view} />
        <CustomerForecastCard view={view} />
        <DelayRiskCard view={view} />
        <CommercialRiskCard view={view} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CashTimelineCard({ view }: { view: ForecastsView }) {
  if (view.cashTimeline.failed) return <GroupError what="the cash timeline" />;
  const t = view.cashTimeline.data;
  const metric = cashTimelineMetric(t);

  return (
    <SignalCard
      title={`Cash timeline (${t.horizonWeeks} weeks)`}
      kind={metric.provenance.kind}
      provenance={metric.provenance}
    >
      {!t.sufficient ? (
        <EmptyNote>
          Not enough dated cash events to project — add due dates to invoices, or record retention
          and tax, and the timeline fills in.
        </EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Money in" value={formatGbp(t.totalInflow)} />
            <Stat label="Money out" value={formatGbp(t.totalOutflow)} />
            <Stat
              label="Net change"
              value={`${t.netMovement >= 0 ? "+" : "−"}${formatGbp(Math.abs(t.netMovement))}`}
              sub="change, not a balance"
            />
            <Stat
              label="Tightest point"
              value={`${t.lowestCumulative >= 0 ? "+" : "−"}${formatGbp(Math.abs(t.lowestCumulative))}`}
              sub={
                t.lowestWeekIndex != null ? `week ${t.lowestWeekIndex + 1}` : null
              }
            />
          </dl>

          {t.shortfall ? (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm text-rose-900">
              <p className="font-medium">Projected cash dips below today.</p>
              <p className="mt-1 text-xs">
                The running change reaches {formatGbp(t.lowestCumulative)} by week{" "}
                {(t.lowestWeekIndex ?? 0) + 1} — more leaves than arrives on the dated events, a gap
                today&apos;s balance would need to cover.
              </p>
            </div>
          ) : null}

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">Week</th>
                  <th className="py-1 px-2 text-right font-medium">In</th>
                  <th className="py-1 px-2 text-right font-medium">Out</th>
                  <th className="py-1 pl-2 text-right font-medium">Running</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {t.weeks.map((w) => (
                  <tr key={w.index}>
                    <td className="py-1 pr-2 text-slate-600">{weekLabel(w.startDay)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-emerald-700">
                      {w.inflow > 0 ? formatGbp(w.inflow) : "—"}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums text-rose-700">
                      {w.outflow > 0 ? formatGbp(w.outflow) : "—"}
                    </td>
                    <td
                      className={`py-1 pl-2 text-right font-medium tabular-nums ${w.cumulativeNet < 0 ? "text-rose-700" : "text-slate-800"}`}
                    >
                      {w.cumulativeNet >= 0 ? "" : "−"}
                      {formatGbp(Math.abs(w.cumulativeNet))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {t.undated.inflow > 0 || t.undated.outflow > 0 || t.beyondHorizon.count > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              {t.undated.outflow > 0
                ? `${formatGbp(t.undated.outflow)} owed with no due date (not placed). `
                : ""}
              {t.undated.inflow > 0
                ? `${formatGbp(t.undated.inflow)} of receivables have no date. `
                : ""}
              {t.beyondHorizon.count > 0
                ? `${t.beyondHorizon.count} event${t.beyondHorizon.count === 1 ? "" : "s"} fall beyond the horizon.`
                : ""}
            </p>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function LabourCard({ view }: { view: ForecastsView }) {
  if (view.labour.failed) return <GroupError what="the labour forecast" />;
  const f = view.labour.data;
  const metric = labourForecastMetric(f);

  return (
    <SignalCard
      title={`Labour capacity (${f.horizonWeeks} weeks)`}
      kind={metric.provenance.kind}
      provenance={metric.provenance}
    >
      {!f.sufficient ? (
        <EmptyNote>No team members to forecast capacity for.</EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rostered" value={`${f.totalRosteredHours}h`} />
            <Stat
              label="Capacity"
              value={`${f.totalCapacityHours}h`}
              sub={`${f.activeMemberCount} × ${f.standardWeeklyHours}h/wk (assumed)`}
            />
            <Stat
              label="Peak week"
              value={f.peakUtilisationPct != null ? `${f.peakUtilisationPct}%` : "—"}
              sub="utilisation"
            />
            <Stat
              label="Overbooked"
              value={f.anyOverbooked ? "Yes" : "No"}
              sub={f.anyOverbooked ? "some weeks exceed capacity" : null}
            />
          </dl>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">Week</th>
                  <th className="py-1 px-2 text-right font-medium">Rostered</th>
                  <th className="py-1 px-2 text-right font-medium">Available</th>
                  <th className="py-1 pl-2 text-right font-medium">Used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {f.weeks.map((w) => (
                  <tr key={w.index}>
                    <td className="py-1 pr-2 text-slate-600">{weekLabel(w.startDay)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-slate-800">
                      {w.rosteredHours}h
                    </td>
                    <td
                      className={`py-1 px-2 text-right tabular-nums ${w.overbooked ? "text-rose-700" : "text-slate-600"}`}
                    >
                      {w.overbooked ? `−${Math.abs(w.availableHours)}h` : `${w.availableHours}h`}
                    </td>
                    <td className="py-1 pl-2 text-right font-medium tabular-nums text-slate-800">
                      {w.utilisationPct != null ? `${w.utilisationPct}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SignalCard>
  );
}

const CHURN_BAND_CLASS: Record<ChurnBand, string> = {
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  at_risk: "bg-amber-50 text-amber-800 border-amber-200",
  lapsed: "bg-rose-50 text-rose-800 border-rose-200",
  insufficient: "bg-slate-100 text-slate-600 border-slate-200",
};

function ChurnPill({ band }: { band: ChurnBand }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${CHURN_BAND_CLASS[band]}`}
    >
      {CHURN_BAND_LABEL[band]}
    </span>
  );
}

function CustomerForecastCard({ view }: { view: ForecastsView }) {
  if (view.customerForecast.failed) return <GroupError what="the customer value forecast" />;
  const f = view.customerForecast.data;
  const metric = customerLtvForecastMetric(f);

  return (
    <SignalCard
      title={`Customer value forecast (${f.horizonMonths} months)`}
      kind={metric.provenance.kind}
      provenance={metric.provenance}
    >
      {!f.sufficient ? (
        <EmptyNote>
          Not enough repeat history to project — a customer needs at least{" "}
          {/* the pure lib's MIN_ORDERS_FOR_FORECAST, stated plainly */}
          two invoices on different days before a repeat rate can be estimated. Values appear as your
          customers order again.
        </EmptyNote>
      ) : (
        <>
          <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
            <strong>Estimate, not a fact.</strong> A straight-line projection from each customer&apos;s
            own order history — shown so you can check the maths, never a hidden score.
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={`Projected (${f.horizonMonths}mo)`}
              value={formatGbp(f.projectedTotal)}
              sub={`${f.customersProjected} customer${f.customersProjected === 1 ? "" : "s"}`}
            />
            <Stat label="At risk" value={String(f.atRiskCount)} sub="overdue vs their rhythm" />
            <Stat label="Lapsed" value={String(f.lapsedCount)} sub="projection withheld" />
            <Stat label="Considered" value={String(f.customersConsidered)} sub="with invoices" />
          </dl>

          {f.top.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-1 pr-2 font-medium">Customer</th>
                    <th className="py-1 px-2 text-right font-medium">Avg order</th>
                    <th className="py-1 px-2 text-right font-medium">Orders/yr</th>
                    <th className="py-1 px-2 text-right font-medium">Projected</th>
                    <th className="py-1 pl-2 text-right font-medium">Signal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {f.top.map((c) => (
                    <tr key={c.customerId}>
                      <td className="py-1 pr-2">
                        <Link
                          href={c.href}
                          className="inline-block max-w-[11rem] truncate align-bottom text-slate-700 hover:underline"
                        >
                          {c.name}
                        </Link>
                      </td>
                      <td className="py-1 px-2 text-right tabular-nums text-slate-600">
                        {formatGbp(c.avgOrderValue)}
                      </td>
                      <td className="py-1 px-2 text-right tabular-nums text-slate-600">
                        {c.ordersPerYear != null ? c.ordersPerYear.toFixed(1) : "—"}
                      </td>
                      <td className="py-1 px-2 text-right font-medium tabular-nums text-slate-800">
                        {c.projectedHorizonValue != null ? formatGbp(c.projectedHorizonValue) : "—"}
                      </td>
                      <td className="py-1 pl-2 text-right">
                        <ChurnPill band={c.churn} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {f.atRisk.length > 0 ? (
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
              <p className="text-sm font-medium text-slate-800">Worth a call</p>
              <ul className="mt-1 space-y-1">
                {f.atRisk.slice(0, 6).map((c) => (
                  <li
                    key={c.customerId}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <Link href={c.href} className="min-w-0 truncate text-slate-700 hover:underline">
                      {c.name}
                    </Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                      <span className="tabular-nums">
                        {c.daysSinceLastActivity}d since last
                        {c.medianCadenceDays != null
                          ? ` · usually every ${Math.round(c.medianCadenceDays)}d`
                          : ""}
                      </span>
                      <ChurnPill band={c.churn} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function DelayRiskCard({ view }: { view: ForecastsView }) {
  if (view.delayRisk.failed) return <GroupError what="delay risk" />;
  const b = view.delayRisk.data;
  const metric = delayRiskMetric(b);

  return (
    <SignalCard title="Delivery / delay risk" kind={metric.provenance.kind} provenance={metric.provenance}>
      {b.jobs.length === 0 ? (
        <EmptyNote>
          No recorded delay signals across {b.jobsConsidered} assessed job
          {b.jobsConsidered === 1 ? "" : "s"} — nothing behind plan, stalled or going backwards.
        </EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Jobs at risk" value={String(b.jobsAtRisk)} sub="≥1 high signal" />
            <Stat label="To watch" value={String(b.jobsWatch)} />
            <Stat label="Behind plan" value={String(b.factorCounts.behind_baseline)} />
            <Stat label="Stalled" value={String(b.factorCounts.stalled)} />
          </dl>
          <ul className="mt-3 space-y-2">
            {b.jobs.slice(0, 6).map((j) => (
              <li key={j.jobId} className="text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={j.href} className="min-w-0 truncate font-medium text-slate-800 hover:underline">
                    {j.label ?? "Job"}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">
                    {j.highFactorCount > 0 ? `${j.highFactorCount} high` : `${j.watchFactorCount} watch`}
                  </span>
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {j.factors.map((factor) => (
                    <li key={factor.key} className="flex items-baseline gap-2 text-xs text-slate-500">
                      <span
                        className={`shrink-0 font-medium uppercase ${factor.severity === "high" ? "text-rose-600" : "text-amber-600"}`}
                      >
                        [{DELAY_FACTOR_LABEL[factor.key]}]
                      </span>
                      <span className="min-w-0">{factor.detail}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {b.overdueMilestoneCount > 0 || b.openEotWorkingDaysLost > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              Programme-wide: {b.overdueMilestoneCount} overdue milestone
              {b.overdueMilestoneCount === 1 ? "" : "s"}, {b.openEotWorkingDaysLost} open EoT working
              days.
            </p>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function CommercialRiskCard({ view }: { view: ForecastsView }) {
  const b = view.commercialRisk;
  const metric = commercialRiskMetric(b);

  return (
    <SignalCard title="Commercial risk" kind={metric.provenance.kind} provenance={metric.provenance}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="High" value={String(b.highCount)} />
        <Stat label="Watch" value={String(b.watchCount)} />
        <Stat label="Not measurable" value={String(b.insufficientCount)} />
      </dl>
      <ul className="mt-3 space-y-2">
        {b.factors.map((factor) => (
          <li key={factor.key} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-sm font-medium text-slate-800">{factor.label}</p>
              <BandPill band={factor.band} />
            </div>
            <p className="mt-1 text-sm text-slate-600">{factor.detail}</p>
            <p className="mt-1 text-xs text-slate-400">{factor.basis}</p>
          </li>
        ))}
      </ul>
    </SignalCard>
  );
}
