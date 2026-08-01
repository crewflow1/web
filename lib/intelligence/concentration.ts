import { round2, sumMoney } from "@/lib/money";
import { formatDayKeyUK } from "@/lib/time/format";
import { labelled, type DayWindow, type LabelledMetric } from "./provenance";

/**
 * CUSTOMER CONCENTRATION — revenue share per customer over the trailing 12
 * London months. PURE.
 *
 * ── WHAT COUNTS AS REVENUE ──────────────────────────────────────────────────
 * `invoices.amount` (EX-VAT), the same revenue definition as
 * lib/profitability/compute.ts — VAT is collected on HMRC's behalf, not
 * income, and a concentration figure quoted on gross would overstate every
 * share's £ by ~20 % while leaving the percentages the same, which is exactly
 * the kind of quiet inconsistency two surfaces then argue about.
 *
 * POPULATION: every NON-DRAFT invoice whose creation instant falls inside the
 * window, bucketed to its Europe/London day via `formatDayKeyUK`. Draft is
 * excluded because it was never issued — nothing was sold. There is NO `void`
 * status in this schema (the enum is draft/sent/awaiting_payment/
 * partially_paid/paid/overdue — verified in lib/invoices/overdue.ts against
 * the live database); if one is ever added it must be excluded here too.
 * Unpaid is NOT excluded: concentration measures who your business DEPENDS
 * on, and a customer who owes you is a dependency, not less of one.
 *
 * ── CUSTOMER ATTRIBUTION ────────────────────────────────────────────────────
 * `invoices.customer_id` is the denormalised anchor (20260915). A
 * pre-backfill row can carry null, so the invoice's JOB is consulted as the
 * fallback — the exact rule lib/commercial/aged-debtors.ts applies, for the
 * same reason: real revenue must not land in "Unattributed" just because a
 * row predates a backfill. What cannot be resolved at all is reported under
 * an explicit unattributed bucket, never dropped (dropping it would shrink
 * the denominator and INFLATE every named customer's share).
 *
 * ── THE HEURISTIC FLAG, AND ITS FLOOR ───────────────────────────────────────
 * `concentrated` is a JUDGEMENT RULE and is labelled as one. The thresholds
 * are stated verbatim in the basis: top customer above 40 % of 12-month
 * revenue, or top three above 70 %. Those are conventional
 * customer-concentration screening lines, not measurements — which is the
 * whole reason this is kind 'heuristic' while the shares themselves are
 * 'derived'.
 *
 * Below MIN_CONCENTRATION_INVOICES the flag is WITHHELD (null, with
 * sampleFloorApplied): two invoices to one customer is 100 % concentration
 * by arithmetic and no information at all — the MIN_RATED_SAMPLE discipline
 * from lib/suppliers/performance, applied to a flag instead of a rate. The
 * shares are still listed; only the verdict is withheld.
 */

// ---------------------------------------------------------------------------
// The stated thresholds (quoted verbatim in the basis string)
// ---------------------------------------------------------------------------

export const TOP1_CONCENTRATION_PCT = 40;
export const TOP3_CONCENTRATION_PCT = 70;

/** Below this many in-window invoices the heuristic verdict is withheld. */
export const MIN_CONCENTRATION_INVOICES = 5;

/** How many named customers the surface lists. */
export const CONCENTRATION_TOP_N = 5;

export const UNATTRIBUTED_LABEL = "Unattributed";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ConcentrationInvoice = {
  id: string;
  status: string;
  /** EX-VAT revenue (`invoices.amount`). */
  amount: number | string | null;
  created_at: string | null;
  /** Denormalised anchor (20260915); null on pre-backfill rows. */
  customer_id: string | null;
  job_id: string | null;
};

export type ConcentrationNaming = {
  customerName: Map<string, string>;
  /** job id → customer id, the pre-backfill fallback. */
  jobCustomer: Map<string, string | null>;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type CustomerShare = {
  /** Null for the unattributed bucket. */
  customerId: string | null;
  name: string;
  revenue: number;
  /** Whole-% share of total, or null when total revenue is 0. */
  sharePct: number | null;
  invoiceCount: number;
  href: string;
};

export type CustomerConcentration = {
  window: DayWindow;
  totalRevenue: number;
  invoiceCount: number;
  customerCount: number;
  /** Top-N by revenue, then everything else folded into one "Others" row. */
  top: CustomerShare[];
  /** Σ revenue outside the top N (0 when N covers everyone). */
  othersRevenue: number;
  top1SharePct: number | null;
  top3SharePct: number | null;
  /**
   * The heuristic verdict — null when withheld below the sample floor. The
   * thresholds live in the exported constants and are quoted in the basis.
   */
  concentrated: boolean | null;
  /** Which rule fired, verbatim, when `concentrated` is true. */
  flaggedBecause: string | null;
};

const DRAFT = "draft";

/** Whole-percent share, or null when the denominator is zero. */
function share(revenue: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((revenue / total) * 100);
}

export function computeCustomerConcentration(input: {
  invoices: ConcentrationInvoice[];
  naming: ConcentrationNaming;
  window: DayWindow;
}): CustomerConcentration {
  const { fromDay, toDay } = input.window;

  // In-window, non-draft. The day comparison is lexicographic on London day
  // keys — exact, and immune to the BST boundary by construction.
  const counted = input.invoices.filter((inv) => {
    if (inv.status === DRAFT) return false;
    if (!inv.created_at) return false;
    const day = formatDayKeyUK(inv.created_at);
    return day >= fromDay && day <= toDay;
  });

  type Acc = { revenue: number; count: number };
  const byCustomer = new Map<string, Acc>();
  const UNATTRIBUTED_KEY = "";
  for (const inv of counted) {
    const customerId =
      inv.customer_id ??
      (inv.job_id ? input.naming.jobCustomer.get(inv.job_id) ?? null : null);
    const key = customerId ?? UNATTRIBUTED_KEY;
    const acc = byCustomer.get(key) ?? { revenue: 0, count: 0 };
    acc.revenue = sumMoney([acc.revenue, inv.amount]);
    acc.count += 1;
    byCustomer.set(key, acc);
  }

  const totalRevenue = sumMoney([...byCustomer.values()].map((a) => a.revenue));

  const shares: CustomerShare[] = [...byCustomer.entries()].map(([key, acc]) => ({
    customerId: key === UNATTRIBUTED_KEY ? null : key,
    name:
      key === UNATTRIBUTED_KEY
        ? UNATTRIBUTED_LABEL
        : input.naming.customerName.get(key) || "Unnamed customer",
    revenue: acc.revenue,
    sharePct: share(acc.revenue, totalRevenue),
    invoiceCount: acc.count,
    href: key === UNATTRIBUTED_KEY ? "/invoices" : `/customers/${key}`,
  }));

  // Deterministic total order: biggest revenue, then name, then id.
  shares.sort(
    (a, b) =>
      b.revenue - a.revenue ||
      a.name.localeCompare(b.name) ||
      (a.customerId ?? "").localeCompare(b.customerId ?? ""),
  );

  const top = shares.slice(0, CONCENTRATION_TOP_N);
  const othersRevenue = round2(
    shares.slice(CONCENTRATION_TOP_N).reduce((s, r) => s + r.revenue, 0),
  );

  const top1SharePct = shares.length > 0 ? shares[0]!.sharePct : null;
  const top3Revenue = round2(shares.slice(0, 3).reduce((s, r) => s + r.revenue, 0));
  const top3SharePct = share(top3Revenue, totalRevenue);

  // The heuristic verdict, floored on sample size (see the header).
  let concentrated: boolean | null = null;
  let flaggedBecause: string | null = null;
  if (counted.length >= MIN_CONCENTRATION_INVOICES && totalRevenue > 0) {
    const top1Hit = top1SharePct != null && top1SharePct > TOP1_CONCENTRATION_PCT;
    const top3Hit = top3SharePct != null && top3SharePct > TOP3_CONCENTRATION_PCT;
    concentrated = top1Hit || top3Hit;
    if (top1Hit) {
      flaggedBecause = `Top customer holds ${top1SharePct}% of 12-month revenue (rule: above ${TOP1_CONCENTRATION_PCT}%).`;
    } else if (top3Hit) {
      flaggedBecause = `Top three customers hold ${top3SharePct}% of 12-month revenue (rule: above ${TOP3_CONCENTRATION_PCT}%).`;
    }
  }

  return {
    window: input.window,
    totalRevenue,
    invoiceCount: counted.length,
    customerCount: shares.filter((s) => s.customerId != null).length,
    top,
    othersRevenue,
    top1SharePct,
    top3SharePct,
    concentrated,
    flaggedBecause,
  };
}

/** The shares themselves: DERIVED — exact division of summed ex-VAT invoices. */
export function concentrationSharesMetric(
  c: CustomerConcentration,
): LabelledMetric<CustomerConcentration> {
  return labelled(c, {
    kind: "derived",
    basis:
      "Each customer's share of ex-VAT invoiced revenue over the trailing 12 London months " +
      "(issued invoices only — drafts excluded; unpaid still counts, because dependency is " +
      "about who the work comes from, not who has settled). Invoices whose customer can't be " +
      "resolved are shown as Unattributed, never dropped.",
    window: c.window,
    computedFrom: [
      { label: "Invoices", href: "/invoices" },
      { label: "Customers", href: "/customers" },
    ],
  });
}

/** The verdict: HEURISTIC — the thresholds are choices, and they are stated. */
export function concentrationFlagMetric(
  c: CustomerConcentration,
): LabelledMetric<{ concentrated: boolean | null; flaggedBecause: string | null }> {
  return labelled(
    { concentrated: c.concentrated, flaggedBecause: c.flaggedBecause },
    {
      kind: "heuristic",
      basis:
        `Flagged when the top customer holds more than ${TOP1_CONCENTRATION_PCT}% of 12-month ` +
        `revenue, or the top three hold more than ${TOP3_CONCENTRATION_PCT}%. Those thresholds ` +
        "are conventional screening lines, not measurements. The verdict is withheld entirely " +
        `below ${MIN_CONCENTRATION_INVOICES} invoices in the window — too few to mean anything.`,
      window: c.window,
      computedFrom: [{ label: "Invoices", href: "/invoices" }],
      sampleFloorApplied: c.concentrated === null,
    },
  );
}
