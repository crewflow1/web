import Link from "next/link";
import type { ReactNode } from "react";
import { formatGbp } from "@/lib/money";
import { formatDateShortUK } from "@/lib/time/format";
import { formatRate, formatRateCompact, sampleCaveat, type Ratio } from "@/lib/suppliers/performance";
import {
  SIGNAL_KIND_DESCRIPTION,
  SIGNAL_KIND_LABEL,
  type SignalKind,
  type SignalProvenance,
} from "@/lib/intelligence/provenance";
import { utilisationMetric } from "@/lib/intelligence/utilisation";
import {
  concentrationFlagMetric,
  concentrationSharesMetric,
} from "@/lib/intelligence/concentration";
import { regressingMetric, stalledMetric } from "@/lib/intelligence/progress-rollup";
import { agedDebtMetric, retentionExposureMetric } from "@/lib/intelligence/exposure";
import { cvrBandsMetric, cvrTotalMetric } from "@/lib/intelligence/cvr-rollup";
import { materialDemandMetric } from "@/lib/intelligence/material-demand";
import { formatMaterialQty } from "@/lib/material-requests/fulfilment";
import { snagPatternsMetric } from "@/lib/intelligence/snag-patterns";
import {
  supplierReliabilityMetric,
  supplierRiskFlagsMetric,
} from "@/lib/intelligence/supplier-performance";
import type { CompanySignalsView } from "@/server/services/intelligence";

/**
 * COMPANY SIGNALS — the deterministic section of /insights.
 *
 * Every card renders a LabelledMetric: the value, its kind badge
 * (FACT / DERIVED / HEURISTIC as TEXT, never colour alone), the plain-English
 * basis, the freshness line and drill-through evidence links. A failed group
 * renders an explicit error block — NEVER an empty metric (a failed read and
 * an empty ledger are different claims; lib/supabase/read-failure).
 *
 * No AI anywhere in this section: it sits on the AI-branded /insights page
 * precisely because that page already promises "deterministic signals as the
 * authoritative source" — this section IS that source, and says so.
 */

// ---------------------------------------------------------------------------
// Building blocks
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

/** The basis + window + evidence footer every card carries. */
function ProvenanceFooter({ provenance }: { provenance: SignalProvenance }) {
  return (
    <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
      <p className="text-xs leading-relaxed text-slate-500">{provenance.basis}</p>
      {provenance.window ? (
        <p className="text-xs text-slate-400">
          Window: {formatDateShortUK(`${provenance.window.fromDay}T12:00:00Z`)} –{" "}
          {formatDateShortUK(`${provenance.window.toDay}T12:00:00Z`)} (UK days)
        </p>
      ) : null}
      <p className="text-xs text-slate-400">
        Computed from:{" "}
        {provenance.computedFrom.map((ref, i) => (
          <span key={ref.href}>
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
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <KindBadge kind={kind} />
      </header>
      <div className="mt-3">{children}</div>
      <ProvenanceFooter provenance={provenance} />
    </article>
  );
}

/** The loud error block — a failed read is shown, never blanked. */
function GroupError({ what }: { what: string }) {
  return (
    <article
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-rose-900 sm:p-5"
    >
      <p className="font-medium">Couldn&apos;t load {what}.</p>
      <p className="mt-1 text-xs">
        The read failed, so nothing is shown — a blank figure here would be a claim, and a wrong
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

function RatioLine({ r }: { r: Ratio }) {
  const caveat = sampleCaveat(r);
  return (
    <span>
      {formatRate(r)}
      {caveat ? <span className="text-slate-400"> — {caveat}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function CompanySignals({ view }: { view: CompanySignalsView }) {
  return (
    <section aria-labelledby="company-signals-heading" className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="company-signals-heading" className="text-lg font-semibold text-slate-900">
            Company signals
          </h2>
          <p className="text-xs text-slate-500">
            Data as of {formatDateShortUK(`${view.todayKey}T12:00:00Z`)}
          </p>
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
          Deterministic — computed from your own records, no model involved. Every figure carries
          its label: <strong>Fact</strong> ({SIGNAL_KIND_DESCRIPTION.fact.toLowerCase()}{" "}
          ), <strong>Derived</strong> ({SIGNAL_KIND_DESCRIPTION.derived.toLowerCase()}) or{" "}
          <strong>Heuristic</strong> — a stated rule of thumb whose thresholds are printed with
          the number.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <UtilisationCard view={view} />
        <ConcentrationCard view={view} />
        <ProgressCard view={view} />
        <ExposureCard view={view} />
        <CvrCard view={view} />
        <MaterialsCard view={view} />
        <SnagsCard view={view} />
        <SupplierPerformanceCard view={view} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function UtilisationCard({ view }: { view: CompanySignalsView }) {
  if (view.utilisation.failed) return <GroupError what="staff utilisation" />;
  const u = view.utilisation.data;
  const metric = utilisationMetric(u);
  const t = u.totals;
  const nothing = t.rosteredHours === 0 && t.recordedHours === 0;

  return (
    <SignalCard title="Staff utilisation (30 days)" kind={metric.provenance.kind} provenance={metric.provenance}>
      {nothing ? (
        <EmptyNote>No shifts rostered and no time clocked in the window.</EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rostered" value={`${t.rosteredHours}h`} />
            <Stat label="Recorded" value={`${t.recordedHours}h`} />
            <Stat
              label="Coverage"
              value={t.coverage.pct != null ? `${t.coverage.pct}%` : "—"}
              sub={t.coverage.pct == null ? "Too few rostered hours to rate" : null}
            />
            <Stat
              label="Labour cost"
              value={formatGbp(t.labourCost)}
              sub={
                t.membersWithoutRate > 0
                  ? `${t.membersWithoutRate} member${t.membersWithoutRate === 1 ? "" : "s"} without a rate — not priced`
                  : null
              }
            />
          </dl>
          {t.formerMemberRecordedHours > 0 || t.formerMemberRosteredHours > 0 ? (
            <p className="mt-2 text-xs text-slate-500">
              Totals include {t.formerMemberRecordedHours}h recorded
              {t.formerMemberRosteredHours > 0
                ? ` and ${t.formerMemberRosteredHours}h rostered`
                : ""}{" "}
              by people no longer in the team — their labour cost is unknown
              and not priced.
            </p>
          ) : null}
          <ul className="mt-3 space-y-1">
            {u.members
              .filter((m) => m.rosteredHours > 0 || m.recordedHours > 0)
              .slice(0, 5)
              .map((m) => (
                <li key={m.userId} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-slate-700">{m.name ?? "Unnamed member"}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {m.recordedHours}h of {m.rosteredHours}h
                    {m.coverage.pct != null ? ` (${m.coverage.pct}%)` : ""}
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </SignalCard>
  );
}

function ConcentrationCard({ view }: { view: CompanySignalsView }) {
  if (view.concentration.failed) return <GroupError what="customer concentration" />;
  const c = view.concentration.data;
  const shares = concentrationSharesMetric(c);
  const flag = concentrationFlagMetric(c);

  return (
    <SignalCard
      title="Customer concentration (12 months)"
      kind={shares.provenance.kind}
      provenance={shares.provenance}
    >
      {c.invoiceCount === 0 ? (
        <EmptyNote>No invoices issued in the last 12 months.</EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <Stat label="Invoiced (ex-VAT)" value={formatGbp(c.totalRevenue)} sub={`${c.invoiceCount} invoices`} />
            <Stat
              label="Top customer share"
              value={c.top1SharePct != null ? `${c.top1SharePct}%` : "—"}
              sub={c.top3SharePct != null ? `Top 3: ${c.top3SharePct}%` : null}
            />
          </dl>
          <ul className="mt-3 space-y-1">
            {c.top.map((s) => (
              <li key={s.customerId ?? "unattributed"} className="flex items-baseline justify-between gap-2 text-sm">
                <Link href={s.href} className="truncate text-slate-700 hover:underline">
                  {s.name}
                </Link>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {formatGbp(s.revenue)}
                  {s.sharePct != null ? ` (${s.sharePct}%)` : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-slate-700">
                {c.concentrated === null
                  ? "Concentration verdict withheld — fewer than 5 invoices in the window."
                  : c.concentrated
                    ? c.flaggedBecause
                    : "Not concentrated by the stated thresholds."}
              </p>
              <KindBadge kind={flag.provenance.kind} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{flag.provenance.basis}</p>
          </div>
        </>
      )}
    </SignalCard>
  );
}

function ProgressCard({ view }: { view: CompanySignalsView }) {
  if (view.progress.failed) return <GroupError what="job progress signals" />;
  const { rollup, capped } = view.progress.data;
  const stalled = stalledMetric(rollup);
  const regressing = regressingMetric(rollup);

  return (
    <SignalCard title="Job progress" kind="heuristic" provenance={stalled.provenance}>
      {rollup.activeJobs === 0 ? (
        <EmptyNote>No jobs are in progress.</EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="In progress" value={String(rollup.activeJobs)} />
            <Stat label="With readings" value={String(rollup.assessedJobs)} />
            <Stat label="Stalled" value={String(rollup.stalled.length)} />
            <Stat label="Went backwards" value={String(rollup.regressing.length)} />
          </dl>
          {capped ? (
            <p className="mt-2 text-xs text-amber-700">
              Showing the first 200 in-progress jobs — the rest are not assessed on this card.
            </p>
          ) : null}
          {rollup.stalled.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {rollup.stalled.slice(0, 5).map((j) => (
                <li key={j.jobId} className="flex items-baseline justify-between gap-2 text-sm">
                  <Link href={j.href} className="truncate text-slate-700 hover:underline">
                    {j.label ?? "Job"}
                  </Link>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {j.lastPercent}% — {j.daysSince} days quiet
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {rollup.regressing.length > 0 ? (
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">Went backwards</p>
                <KindBadge kind={regressing.provenance.kind} />
              </div>
              <ul className="mt-1 space-y-1">
                {rollup.regressing.slice(0, 5).map((j) => (
                  <li key={j.jobId} className="flex items-baseline justify-between gap-2 text-sm">
                    <Link href={j.href} className="truncate text-slate-700 hover:underline">
                      {j.label ?? "Job"}
                    </Link>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {j.fromPercent}% → {j.latestPercent}%
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">{regressing.provenance.basis}</p>
            </div>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function ExposureCard({ view }: { view: CompanySignalsView }) {
  if (view.exposure.failed) return <GroupError what="retention and aged debt" />;
  const { retention, agedDebt } = view.exposure.data;
  const rm = retentionExposureMetric(retention);
  const dm = agedDebtMetric(agedDebt);

  return (
    <SignalCard title="Money held and money late" kind={rm.provenance.kind} provenance={rm.provenance}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Retention not yet due"
          value={formatGbp(retention.notYetDue)}
          sub={
            retention.awaitingCompletion > 0
              ? `${formatGbp(retention.awaitingCompletion)} awaiting a completion date`
              : null
          }
        />
        <Stat label="Retention claimable now" value={formatGbp(retention.claimableNow)} />
        <Stat
          label="Owed past due"
          value={formatGbp(agedDebt.pastDue)}
          sub={`of ${formatGbp(agedDebt.total)} owed`}
        />
        <Stat
          label="Owed 90+ days"
          value={formatGbp(agedDebt.over90)}
          sub={agedDebt.undated > 0 ? `${formatGbp(agedDebt.undated)} has no due date` : null}
        />
      </dl>
      <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
        <p className="text-xs text-slate-500">{dm.provenance.basis}</p>
      </div>
    </SignalCard>
  );
}

function CvrCard({ view }: { view: CompanySignalsView }) {
  if (view.cvr.failed) return <GroupError what="budget forecasts" />;
  const r = view.cvr.data;
  const total = cvrTotalMetric(r);
  const bands = cvrBandsMetric(r);

  return (
    <SignalCard title="Budget forecast (CVR)" kind={total.provenance.kind} provenance={total.provenance}>
      {r.jobsWithBudget === 0 ? (
        <EmptyNote>
          No live job carries a cost baseline yet — set one on a job&apos;s commercial page and the
          forecast rolls up here.
        </EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Budgeted jobs" value={String(r.jobsWithBudget)} sub={r.jobsWithoutBudget > 0 ? `${r.jobsWithoutBudget} without a baseline` : null} />
            <Stat
              label="Forecast vs plan"
              value={`${r.forecastVarianceTotal >= 0 ? "+" : "−"}${formatGbp(Math.abs(r.forecastVarianceTotal))}`}
              sub={r.forecastVarianceTotal >= 0 ? "headroom (a floor, not a promise)" : "over plan already"}
            />
            <Stat label="Forecast over budget" value={String(r.redCount)} />
            <Stat label="Headroom under 10%" value={String(r.amberCount)} />
          </dl>
          {r.lines.filter((l) => l.band !== "ok").length > 0 ? (
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">Jobs to look at</p>
                <KindBadge kind={bands.provenance.kind} />
              </div>
              <ul className="mt-1 space-y-1">
                {r.lines
                  .filter((l) => l.band !== "ok")
                  .slice(0, 5)
                  .map((l) => (
                    <li key={l.jobId} className="flex items-baseline justify-between gap-2 text-sm">
                      <Link href={l.href} className="truncate text-slate-700 hover:underline">
                        <span className="mr-1 font-medium uppercase text-slate-500">
                          [{l.band === "red" ? "Over" : "Tight"}]
                        </span>
                        {l.label ?? "Job"}
                      </Link>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {formatGbp(l.forecastFinalCost)} vs {formatGbp(l.revisedBudget)}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">{bands.provenance.basis}</p>
            </div>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function MaterialsCard({ view }: { view: CompanySignalsView }) {
  if (view.materials.failed) return <GroupError what="material demand" />;
  const d = view.materials.data;
  const metric = materialDemandMetric(d);

  return (
    <SignalCard title="Materials still owed to sites" kind={metric.provenance.kind} provenance={metric.provenance}>
      {d.openRequestCount === 0 && d.awaitingApprovalCount === 0 ? (
        <EmptyNote>No open material requests.</EmptyNote>
      ) : !d.measurable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900">
          <p className="font-medium">Fulfilment can&apos;t be measured right now.</p>
          <p className="mt-1 text-xs">
            The stock module couldn&apos;t be reached, so what has already been issued is unknown —
            showing requested quantities as outstanding would over-order, and showing zero would
            starve the site. {d.openRequestCount} approved request
            {d.openRequestCount === 1 ? "" : "s"} are open.
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Open requests" value={String(d.openRequestCount)} sub={d.awaitingApprovalCount > 0 ? `${d.awaitingApprovalCount} awaiting approval` : null} />
            <Stat label="Items outstanding" value={String(d.items.filter((i) => (i.outstanding ?? 0) > 0).length)} />
            <Stat label="Past needed-by" value={String(d.overdueCount)} />
          </dl>
          <ul className="mt-3 space-y-1">
            {d.items
              .filter((i) => (i.outstanding ?? 0) > 0)
              .slice(0, 6)
              .map((i) => (
                <li key={i.key} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-slate-700">{i.label}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {formatMaterialQty(i.outstanding)} {i.unit} of {formatMaterialQty(i.requested)}{" "}
                    {i.unit}
                  </span>
                </li>
              ))}
          </ul>
          {d.items.every((i) => (i.outstanding ?? 0) <= 0) ? (
            <EmptyNote>Everything approved has been issued.</EmptyNote>
          ) : null}
        </>
      )}
    </SignalCard>
  );
}

function SnagsCard({ view }: { view: CompanySignalsView }) {
  if (view.snags.failed) return <GroupError what="snag patterns" />;
  const p = view.snags.data;
  const metric = snagPatternsMetric(p);

  return (
    <SignalCard title="Snags by job and trade" kind={metric.provenance.kind} provenance={metric.provenance}>
      {p.total === 0 ? (
        <EmptyNote>No snags recorded yet.</EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Open" value={String(p.open)} sub={`${p.total} recorded in total`} />
            <Stat label="Past due date" value={String(p.overdue)} />
            <div className="min-w-0 col-span-2 sm:col-span-1">
              <dt className="text-xs text-slate-500">Sign-off rate</dt>
              <dd className="text-sm text-slate-700">
                <RatioLine r={p.verification} />
              </dd>
            </div>
          </dl>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">By trade</p>
              <ul className="mt-1 space-y-1">
                {p.byTrade.slice(0, 4).map((g) => (
                  <li key={g.key || "no-trade"} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate text-slate-700">{g.label}</span>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {g.open} open / {g.total}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">By job</p>
              <ul className="mt-1 space-y-1">
                {p.byJob.slice(0, 4).map((g) => (
                  <li key={g.key || "no-job"} className="flex items-baseline justify-between gap-2 text-sm">
                    {g.href ? (
                      <Link href={g.href} className="truncate text-slate-700 hover:underline">
                        {g.label}
                      </Link>
                    ) : (
                      <span className="truncate text-slate-700">{g.label}</span>
                    )}
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {g.open} open / {g.total}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </SignalCard>
  );
}

function SupplierPerformanceCard({ view }: { view: CompanySignalsView }) {
  if (view.supplierPerformance.failed) return <GroupError what="supplier performance" />;
  const r = view.supplierPerformance.data;
  const reliability = supplierReliabilityMetric(r);
  const flags = supplierRiskFlagsMetric(r);
  const anyFlag = r.overBillingFlags.length > 0 || r.slowSettlementFlags.length > 0;

  return (
    <SignalCard
      title="Supplier performance"
      kind={reliability.provenance.kind}
      provenance={reliability.provenance}
    >
      {r.suppliersWithRecord === 0 ? (
        <EmptyNote>
          {r.suppliersConsidered === 0
            ? "No suppliers on the books yet."
            : `No trading history for any of your ${r.suppliersConsidered} suppliers yet — a record appears once an order is delivered or a bill is linked.`}
        </EmptyNote>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="With a record"
              value={String(r.suppliersWithRecord)}
              sub={r.suppliersEmpty > 0 ? `${r.suppliersEmpty} not yet traded` : null}
            />
            <div className="min-w-0 col-span-2 sm:col-span-1">
              <dt className="text-xs text-slate-500">Org on-time delivery</dt>
              <dd className="text-sm text-slate-700">
                {/* Org late rate inverted to on-time for the label; the Ratio
                    itself is the late/judgeable count from the authority. */}
                <RatioLine r={r.orgPunctuality} />
              </dd>
            </div>
            <Stat
              label="Over-invoiced excess"
              value={formatGbp(r.overBilledExcessTotal)}
              sub={r.withheldPriceRating > 0 ? `${r.withheldPriceRating} too few to rate` : null}
            />
            <Stat
              label="Rating withheld"
              value={String(r.withheldDeliveryRating + r.withheldSettlementRating)}
              sub="too few records"
            />
          </dl>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Most reliable (fewest late)
              </p>
              {r.mostReliable.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {r.mostReliable.map((s) => (
                    <li
                      key={s.supplierId}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <Link href={s.href} className="truncate text-slate-700 hover:underline">
                        {s.supplierName || "Unnamed supplier"}
                      </Link>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {formatRateCompact(s.punctuality)} late
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  No supplier has {`≥`} 5 judgeable deliveries yet.
                </p>
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Least reliable (most late)
              </p>
              {r.leastReliable.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {r.leastReliable.map((s) => (
                    <li
                      key={s.supplierId}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <Link href={s.href} className="truncate text-slate-700 hover:underline">
                        {s.supplierName || "Unnamed supplier"}
                      </Link>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {formatRateCompact(s.punctuality)} late
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  No supplier has {`≥`} 5 judgeable deliveries yet.
                </p>
              )}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-800">Flags to look at</p>
              <KindBadge kind={flags.provenance.kind} />
            </div>
            {anyFlag ? (
              <ul className="mt-1 space-y-1">
                {r.overBillingFlags.map((s) => (
                  <li
                    key={`ob-${s.supplierId}`}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <Link href={s.href} className="truncate text-slate-700 hover:underline">
                      <span className="mr-1 font-medium uppercase text-slate-500">
                        [Over-invoiced]
                      </span>
                      {s.supplierName || "Unnamed supplier"}
                    </Link>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {formatRateCompact(s.overBilled)} · {formatGbp(s.overBilledExcess)}
                    </span>
                  </li>
                ))}
                {r.slowSettlementFlags.map((s) => (
                  <li
                    key={`ss-${s.supplierId}`}
                    className="flex items-baseline justify-between gap-2 text-sm"
                  >
                    <Link href={s.href} className="truncate text-slate-700 hover:underline">
                      <span className="mr-1 font-medium uppercase text-slate-500">
                        [We settle slowly]
                      </span>
                      {s.supplierName || "Unnamed supplier"}
                    </Link>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {formatRateCompact(s.slowShare)} over 60 days
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-slate-700">
                No supplier crosses the stated over-invoicing or slow-settlement thresholds.
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">{flags.provenance.basis}</p>
            <p className="mt-2 text-xs text-slate-400">
              Compare all suppliers side by side on the{" "}
              <Link
                href="/suppliers/compare"
                className="underline decoration-slate-300 hover:text-slate-600"
              >
                comparison page
              </Link>
              .
            </p>
          </div>
        </>
      )}
    </SignalCard>
  );
}
