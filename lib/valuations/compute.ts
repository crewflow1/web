import { round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Construction valuation / application-for-payment — the PURE money model.
 *
 * Mirrors the DB certify math (migration 20261192000000) exactly so the UI
 * projection of a draft and the frozen certified snapshot agree to the penny:
 *
 *   gross_valuation    = work_completed_to_date + materials_on_site + variations_total
 *   net_certified_this = gross_valuation − previous_certified_gross − deductions
 *
 * `net_certified_this` is THIS period's certified increment and becomes the
 * generated stage invoice's ex-VAT `amount`. Because Σ over certified valuations
 * of `net_certified_this` telescopes to (latest gross − Σ deductions), no period
 * is ever billed twice.
 *
 * RETENTION IS NOT APPLIED HERE. It is derived ONCE by the existing authority
 * (lib/retentions/compute.computeRetentionPosition) from the generated invoices'
 * ex-VAT `amount`. The `retentionThis` figure below is a DISPLAY split for the
 * certificate — it never reduces the invoice amount, so retention is applied
 * exactly once, in one place. Subtracting it from the amount here (and then
 * letting the retention authority accrue on the reduced figure) would be the
 * double count; we do not.
 *
 * Server/client-safe: money helpers only.
 */

export const VALUATION_STATUSES = [
  "draft",
  "submitted",
  "certified",
  "invoiced",
  "cancelled",
] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];

export const VALUATION_STATUS_LABEL: Record<ValuationStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  certified: "Certified",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
};

/** Statuses that count toward the certified cumulative base for a job. */
const CERTIFIED_STATUSES = new Set<ValuationStatus>(["certified", "invoiced"]);

export type Numberish = number | string | null | undefined;

export type ValuationFigures = {
  /** work + materials + variations (ex-VAT, cumulative-to-date). */
  gross: number;
  /** Σ prior certified increments this figure builds on. */
  previousCertifiedGross: number;
  /** THIS period's certified increment (ex-VAT) — the stage invoice amount. Never negative. */
  netCertifiedThis: number;
  /** Contract retention withheld on this increment (DISPLAY only). */
  retentionThis: number;
  /** Increment net of retention — the cash the customer releases this period (ex-VAT). */
  netPayableThis: number;
  /** VAT on the certified increment. */
  vat: number;
  /** Invoice total = increment + VAT (the retention holdback is tracked separately). */
  totalDue: number;
  /** True when the raw inputs would certify to a negative increment (blocked at certify). */
  wouldGoNegative: boolean;
};

function clampPct(v: Numberish): number {
  const n = toPounds(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Compute a valuation's figures from explicit ex-VAT scalars. Pure.
 *
 * `previousCertifiedGross` is Σ `net_certified_this` over the job's OTHER
 * certified/invoiced valuations — see `sumCertifiedBase`.
 */
export function computeValuationFigures(input: {
  workCompletedToDate: Numberish;
  materialsOnSite: Numberish;
  variationsTotal: Numberish;
  deductions: Numberish;
  previousCertifiedGross: Numberish;
  retentionPercent: Numberish;
  vatRate: Numberish;
}): ValuationFigures {
  const work = Math.max(0, toPounds(input.workCompletedToDate));
  const materials = Math.max(0, toPounds(input.materialsOnSite));
  const variations = Math.max(0, toPounds(input.variationsTotal));
  const deductions = Math.max(0, toPounds(input.deductions));
  const previousCertifiedGross = round2(Math.max(0, toPounds(input.previousCertifiedGross)));
  const rate = clampPct(input.retentionPercent);
  const vatRate = clampPct(input.vatRate);

  const gross = round2(work + materials + variations);
  const rawNet = round2(gross - previousCertifiedGross - deductions);
  const wouldGoNegative = rawNet < 0;
  const netCertifiedThis = round2(Math.max(0, rawNet));

  const retentionThis = round2((rate / 100) * netCertifiedThis);
  const netPayableThis = round2(netCertifiedThis - retentionThis);
  const vat = round2((vatRate / 100) * netCertifiedThis);
  const totalDue = round2(netCertifiedThis + vat);

  return {
    gross,
    previousCertifiedGross,
    netCertifiedThis,
    retentionThis,
    netPayableThis,
    vat,
    totalDue,
    wouldGoNegative,
  };
}

/** A minimal valuation shape for cumulation over a job's history. */
export type CumulationValuation = {
  id: string;
  status: string | null | undefined;
  net_certified_this: Numberish;
};

/**
 * Σ `net_certified_this` over a job's certified/invoiced valuations, excluding
 * one row (the one being projected/certified). This is the DB's
 * `previous_certified_gross` — the exact base the certify RPC snapshots.
 */
export function sumCertifiedBase(
  valuations: CumulationValuation[],
  excludeId?: string,
): number {
  return sumMoney(
    valuations
      .filter(
        (v) =>
          v.id !== excludeId &&
          CERTIFIED_STATUSES.has((v.status ?? "") as ValuationStatus),
      )
      .map((v) => v.net_certified_this),
  );
}

/**
 * Resolve the figures for a single valuation row against its job's history.
 * For a certified/invoiced row the frozen snapshot columns are authoritative and
 * returned verbatim; for a draft/submitted row the figures are PROJECTED from the
 * live inputs + the current certified base (what it WOULD certify to now).
 */
export function resolveValuationFigures(
  row: {
    id: string;
    status: string | null | undefined;
    work_completed_to_date: Numberish;
    materials_on_site: Numberish;
    deductions: Numberish;
    vat_rate: Numberish;
    variations_total: Numberish;
    gross_valuation: Numberish;
    previous_certified_gross: Numberish;
    net_certified_this: Numberish;
    retention_percent: Numberish;
  },
  jobValuations: CumulationValuation[],
  liveVariationsTotal: Numberish,
  jobRetentionPercent: Numberish,
): ValuationFigures {
  const status = (row.status ?? "") as ValuationStatus;
  if (CERTIFIED_STATUSES.has(status)) {
    // Frozen snapshot is authoritative — recompute the display splits from it.
    const rate = clampPct(row.retention_percent);
    const vatRate = clampPct(row.vat_rate);
    const netCertifiedThis = round2(Math.max(0, toPounds(row.net_certified_this)));
    const retentionThis = round2((rate / 100) * netCertifiedThis);
    return {
      gross: round2(toPounds(row.gross_valuation)),
      previousCertifiedGross: round2(toPounds(row.previous_certified_gross)),
      netCertifiedThis,
      retentionThis,
      netPayableThis: round2(netCertifiedThis - retentionThis),
      vat: round2((vatRate / 100) * netCertifiedThis),
      totalDue: round2(netCertifiedThis + (vatRate / 100) * netCertifiedThis),
      wouldGoNegative: false,
    };
  }
  return computeValuationFigures({
    workCompletedToDate: row.work_completed_to_date,
    materialsOnSite: row.materials_on_site,
    variationsTotal: liveVariationsTotal,
    deductions: row.deductions,
    previousCertifiedGross: sumCertifiedBase(jobValuations, row.id),
    retentionPercent: jobRetentionPercent,
    vatRate: row.vat_rate,
  });
}
