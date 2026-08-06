import Link from "next/link";
import type { ReactNode } from "react";
import { formatGbp } from "@/lib/money";
import { formatRateCompact, sampleCaveat, type Ratio } from "@/lib/suppliers/performance";
import {
  SIGNAL_KIND_DESCRIPTION,
  SIGNAL_KIND_LABEL,
  type SignalKind,
  type SignalProvenance,
} from "@/lib/intelligence/provenance";
import {
  HEALTH_BAND_LABEL,
  healthBandClass,
  type HealthBand,
  type HealthDimension,
} from "@/lib/health/company-health";
import { customerLtvMetric } from "@/lib/health/customer-ltv";
import {
  subcontractorReliabilityMetric,
  subcontractorRiskFlagsMetric,
} from "@/lib/health/subcontractor-score";
import type { CompanyHealthView } from "@/server/services/company-health";

/**
 * COMPANY HEALTH — the deterministic health suite on /insights.
 *
 * A PER-DIMENSION RAG banner (no overall score — see lib/health/company-health.ts),
 * a customer-lifetime-value panel, and a CIS subcontractor scoreboard. Every band
 * shows its word AND its colour (never colour alone), prints the exact rule that
 * fired, and links to the records behind it. Failed groups render an explicit
 * error, never an empty metric. No AI anywhere: this composes existing
 * deterministic authorities only.
 */

// ---------------------------------------------------------------------------
// Shared building blocks (mirrors _company-signals.tsx)
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

function RatioLine({ r }: { r: Ratio }) {
  const caveat = sampleCaveat(r);
  return (
    <span>
      {formatRateCompact(r)}
      {caveat ? <span className="text-slate-400"> — too few to rate</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The health RAG banner
// ---------------------------------------------------------------------------

/** A dot with a text label — colour is NEVER the only signal. */
function BandPill({ band }: { band: HealthBand }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${healthBandClass(band)}`}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {HEALTH_BAND_LABEL[band]}
    </span>
  );
}

function DimensionCard({ dim }: { dim: HealthDimension }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{dim.label}</h3>
        <BandPill band={dim.band} />
      </header>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{dim.basis}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          {SIGNAL_KIND_LABEL[dim.kind]} — thresholds are ratified config
        </span>
        <span className="text-xs text-slate-400">
          {dim.drillThrough.map((ref, i) => (
            <span key={ref.href}>
              {i > 0 ? " · " : ""}
              <Link href={ref.href} className="underline decoration-slate-300 hover:text-slate-600">
                {ref.label}
              </Link>
            </span>
          ))}
        </span>
      </div>
    </article>
  );
}

function HealthBanner({ view }: { view: CompanyHealthView }) {
  return (
    <section aria-labelledby="company-health-heading" className="space-y-3">
      <header className="space-y-1">
        <h2 id="company-health-heading" className="text-lg font-semibold text-slate-900">
          Company health
        </h2>
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
          Five independent dimensions, each banded on its own evidence — there is deliberately{" "}
          <strong>no single overall score</strong> (one blended number would hide which pocket the
          risk is in). Where data is missing, the band is{" "}
          <strong>{HEALTH_BAND_LABEL.insufficient}</strong>, never a green light — an empty ledger is
          not proof of health.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {view.health.dimensions.map((dim) => (
          <DimensionCard key={dim.key} dim={dim} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Customer lifetime value
// ---------------------------------------------------------------------------

function CustomerLtvPanel({ view }: { view: CompanyHealthView }) {
  if (view.ltv.failed) return <GroupError what="customer lifetime value" />;
  const l = view.ltv.data;
  const metric = customerLtvMetric(l);

  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Customer lifetime value</h3>
        <KindBadge kind={metric.provenance.kind} />
      </header>
      <div className="mt-3">
        {l.invoiceCount === 0 ? (
          <EmptyNote>No issued invoices yet — customer value appears once you invoice.</EmptyNote>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <dt className="text-xs text-slate-500">Realised (paid, ex-VAT)</dt>
                <dd className="truncate text-lg font-semibold text-slate-900">
                  {formatGbp(l.realisedTotal)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-slate-500">Committed (invoiced, unpaid)</dt>
                <dd className="truncate text-lg font-semibold text-slate-900">
                  {formatGbp(l.committedTotal)}
                </dd>
              </div>
            </dl>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400">
                    <th className="pb-1 font-medium">Customer</th>
                    <th className="pb-1 text-right font-medium">Realised</th>
                    <th className="pb-1 text-right font-medium">Committed</th>
                  </tr>
                </thead>
                <tbody>
                  {l.top.map((c) => (
                    <tr key={c.customerId ?? "unattributed"} className="border-t border-slate-50">
                      <td className="py-1">
                        <Link
                          href={c.href}
                          className="inline-block max-w-[12rem] truncate align-bottom text-slate-700 hover:underline"
                        >
                          {c.name}
                        </Link>
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-700">
                        {formatGbp(c.realisedValue)}
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-500">
                        {formatGbp(c.committedValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <ProvenanceFooter provenance={metric.provenance} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Subcontractor scoreboard
// ---------------------------------------------------------------------------

function SubcontractorPanel({ view }: { view: CompanyHealthView }) {
  if (view.subcontractors.failed) return <GroupError what="subcontractor scoreboard" />;
  const s = view.subcontractors.data;
  const reliability = subcontractorReliabilityMetric(s);
  const flags = subcontractorRiskFlagsMetric(s);
  const anyFlag = s.overBillingFlags.length > 0 || s.slowSettlementFlags.length > 0;

  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">CIS subcontractor scoreboard</h3>
        <KindBadge kind={reliability.provenance.kind} />
      </header>
      <div className="mt-3">
        {s.subcontractorsConsidered === 0 ? (
          <EmptyNote>
            No CIS subcontractors on record (or you don&apos;t have access to the tax register).
          </EmptyNote>
        ) : s.subcontractorsWithRecord === 0 ? (
          <EmptyNote>
            {s.subcontractorsConsidered} CIS subcontractor
            {s.subcontractorsConsidered === 1 ? "" : "s"} on record, none with trading history yet —
            a record appears once a delivery is posted or a bill is linked.
          </EmptyNote>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400">
                    <th className="pb-1 font-medium">Subcontractor</th>
                    <th className="pb-1 text-right font-medium">Late deliveries</th>
                    <th className="pb-1 text-right font-medium">Over-invoiced</th>
                    <th className="pb-1 text-right font-medium">We settle &gt;60d</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.slice(0, 8).map((row) => (
                    <tr key={row.supplierId} className="border-t border-slate-50">
                      <td className="py-1">
                        <Link
                          href={row.href}
                          className="inline-block max-w-[12rem] truncate align-bottom text-slate-700 hover:underline"
                        >
                          {row.supplierName || "Unnamed subcontractor"}
                        </Link>
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-600">
                        <RatioLine r={row.punctuality} />
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-600">
                        <RatioLine r={row.overBilled} />
                      </td>
                      <td className="py-1 text-right tabular-nums text-slate-600">
                        <RatioLine r={row.slowSettlement} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">Flags to look at</p>
                <KindBadge kind={flags.provenance.kind} />
              </div>
              {anyFlag ? (
                <ul className="mt-1 space-y-1">
                  {s.overBillingFlags.map((row) => (
                    <li
                      key={`ob-${row.supplierId}`}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <Link
                        href={row.href}
                        className="min-w-0 truncate text-slate-700 hover:underline"
                      >
                        <span className="mr-1 font-medium uppercase text-slate-500">
                          [Over-invoiced]
                        </span>
                        {row.supplierName || "Unnamed subcontractor"}
                      </Link>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {formatRateCompact(row.overBilled)} · {formatGbp(row.overBilledExcess)}
                      </span>
                    </li>
                  ))}
                  {s.slowSettlementFlags.map((row) => (
                    <li
                      key={`ss-${row.supplierId}`}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <Link
                        href={row.href}
                        className="min-w-0 truncate text-slate-700 hover:underline"
                      >
                        <span className="mr-1 font-medium uppercase text-slate-500">
                          [We settle slowly]
                        </span>
                        {row.supplierName || "Unnamed subcontractor"}
                      </Link>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {formatRateCompact(row.slowSettlement)} over 60 days
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-700">
                  No subcontractor crosses the stated over-invoicing or slow-settlement thresholds.
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <ProvenanceFooter provenance={reliability.provenance} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function CompanyHealthSection({ view }: { view: CompanyHealthView }) {
  return (
    <section aria-labelledby="health-suite-heading" className="space-y-4">
      <h2 id="health-suite-heading" className="sr-only">
        Company health suite
      </h2>
      <HealthBanner view={view} />
      <div className="grid gap-4 lg:grid-cols-2">
        <CustomerLtvPanel view={view} />
        <SubcontractorPanel view={view} />
      </div>
    </section>
  );
}
