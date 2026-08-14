import type { AgedDebtSummary, RetentionExposure } from "./exposure";
import type { CustomerConcentration } from "./concentration";
import { TOP1_CONCENTRATION_PCT } from "./concentration";
import type { CashTimeline } from "./cash-timeline";
import { labelled, type LabelledMetric, type EvidenceRef, type SignalKind } from "./provenance";

/**
 * COMMERCIAL RISK — a board of INDEPENDENT financial-exposure factors. PURE.
 *
 * ── WHY A BOARD, NOT A SCORE ────────────────────────────────────────────────
 * This is the money-side twin of lib/intelligence/delay-risk.ts, and it obeys
 * the same doctrine as lib/health/company-health.ts: NO single blended grade.
 * "90-day debt", "one customer is 60% of revenue" and "the cash projection dips
 * negative" are risks measured in different units against different denominators;
 * combining them into one number would invent an exchange rate the business does
 * not have. So each factor stands alone, banded ok / watch / high by ONE
 * authority family with its own rule, printed verbatim.
 *
 * ── ABSENCE IS `insufficient`, NEVER `ok` ───────────────────────────────────
 * A factor whose input read failed (null) or has nothing to measure bands
 * `insufficient` — a green "ok" over an unread ledger is exactly the lie the
 * loud-reads / honesty doctrine exists to stop. `insufficient` is a first-class
 * band, not an error.
 *
 * ── COMPOSE, DON'T RE-DERIVE ────────────────────────────────────────────────
 * Every figure comes from an authority that owns it: aged debt and retention
 * from lib/intelligence/exposure, concentration from lib/intelligence/
 * concentration, the cash dip from lib/intelligence/cash-timeline. This module
 * only bands; it computes no money of its own.
 *
 * PURE: no I/O, no clock.
 */

export type CommercialRiskBand = "ok" | "watch" | "high" | "insufficient";

export const COMMERCIAL_FACTOR_ORDER = [
  "cash_shortfall",
  "aged_debt",
  "concentration",
  "retention_overdue",
] as const;
export type CommercialFactorKey = (typeof COMMERCIAL_FACTOR_ORDER)[number];

export const COMMERCIAL_FACTOR_LABEL: Record<CommercialFactorKey, string> = {
  cash_shortfall: "Projected cash shortfall",
  aged_debt: "Aged debt at risk",
  concentration: "Customer concentration",
  retention_overdue: "Overdue retention",
};

export interface CommercialRiskFactor {
  key: CommercialFactorKey;
  label: string;
  band: CommercialRiskBand;
  /** The concrete reading, e.g. "£12,400 owed 90+ days (28% of receivables)". */
  detail: string;
  /** The rule that produced the band, verbatim. */
  basis: string;
  kind: SignalKind;
  drillThrough: EvidenceRef[];
}

export interface CommercialRiskBoard {
  factors: CommercialRiskFactor[];
  /** Factors banded `high`. */
  highCount: number;
  /** Factors banded `watch`. */
  watchCount: number;
  /** Factors that couldn't be measured. */
  insufficientCount: number;
}

export const DEFAULT_COMMERCIAL_THRESHOLDS = {
  /** 90+ day debt over this share of receivables is `high`; any 90+ debt is `watch`. */
  agedDebtHighSharePct: 20,
  /** Top-customer share at/above this is `high` (reuses the concentration authority's flag). */
  concentrationHighPct: TOP1_CONCENTRATION_PCT,
} as const;

export type CommercialThresholds = typeof DEFAULT_COMMERCIAL_THRESHOLDS;

function pctOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

function fmtGbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

export function computeCommercialRiskBoard(
  input: {
    agedDebt: AgedDebtSummary | null;
    concentration: CustomerConcentration | null;
    retention: RetentionExposure | null;
    cash: CashTimeline | null;
  },
  thresholds: CommercialThresholds = DEFAULT_COMMERCIAL_THRESHOLDS,
): CommercialRiskBoard {
  const factors: CommercialRiskFactor[] = [];

  // --- Projected cash shortfall (from the forward timeline) ---
  {
    const drill: EvidenceRef[] = [{ label: "Cash", href: "/cash" }];
    if (!input.cash || !input.cash.sufficient) {
      factors.push({
        key: "cash_shortfall",
        label: COMMERCIAL_FACTOR_LABEL.cash_shortfall,
        band: "insufficient",
        detail: "Not enough dated cash events to project a shortfall.",
        basis: "A shortfall can only be judged once there are dated inflows or outflows to project.",
        kind: "heuristic",
        drillThrough: drill,
      });
    } else {
      const dip = input.cash.lowestCumulative;
      const band: CommercialRiskBand = input.cash.shortfall ? "high" : "ok";
      factors.push({
        key: "cash_shortfall",
        label: COMMERCIAL_FACTOR_LABEL.cash_shortfall,
        band,
        detail: input.cash.shortfall
          ? `Projected cash falls ${fmtGbp(Math.abs(dip))} below today by week ${(input.cash.lowestWeekIndex ?? 0) + 1}`
          : `Projected cash stays above today across ${input.cash.horizonWeeks} weeks (low point ${fmtGbp(dip)})`,
        basis:
          "High when the running change in cash dips below zero within the horizon — more leaves " +
          "than arrives on the dated events, a gap today's balance must cover. This is a change, " +
          "not a bank balance.",
        kind: "heuristic",
        drillThrough: drill,
      });
    }
  }

  // --- Aged debt at risk (90+ day share of receivables) ---
  {
    const drill: EvidenceRef[] = [{ label: "Aged debtors", href: "/reports/ageing" }];
    if (!input.agedDebt) {
      factors.push(insufficient("aged_debt", "Aged-debt ledger couldn't be read.", drill));
    } else if (input.agedDebt.total <= 0) {
      factors.push({
        key: "aged_debt",
        label: COMMERCIAL_FACTOR_LABEL.aged_debt,
        band: "ok",
        detail: "Nothing currently owed to you.",
        basis: "Ok when there is no outstanding debt to age.",
        kind: "heuristic",
        drillThrough: drill,
      });
    } else {
      const share = pctOf(input.agedDebt.over90, input.agedDebt.total);
      const band: CommercialRiskBand =
        input.agedDebt.over90 <= 0
          ? "ok"
          : share != null && share >= thresholds.agedDebtHighSharePct
            ? "high"
            : "watch";
      factors.push({
        key: "aged_debt",
        label: COMMERCIAL_FACTOR_LABEL.aged_debt,
        band,
        detail:
          input.agedDebt.over90 > 0
            ? `${fmtGbp(input.agedDebt.over90)} owed 90+ days${share != null ? ` (${share}% of ${fmtGbp(input.agedDebt.total)})` : ""}`
            : `${fmtGbp(input.agedDebt.pastDue)} past due, none yet 90+ days`,
        basis:
          `High when debt owed 90+ days is ≥ ${thresholds.agedDebtHighSharePct}% of everything owed ` +
          "to you; watch when there is any 90+ day debt below that share. The 90+ band is the debt " +
          "most at risk of never arriving.",
        kind: "heuristic",
        drillThrough: drill,
      });
    }
  }

  // --- Customer concentration (reuses the concentration authority's own flag) ---
  {
    const drill: EvidenceRef[] = [{ label: "Customers", href: "/customers" }];
    if (!input.concentration) {
      factors.push(insufficient("concentration", "Concentration couldn't be read.", drill));
    } else if (input.concentration.concentrated === null) {
      factors.push({
        key: "concentration",
        label: COMMERCIAL_FACTOR_LABEL.concentration,
        band: "insufficient",
        detail: `Too few invoices in the window to judge (${input.concentration.invoiceCount}).`,
        basis:
          "Concentration is withheld below the sample floor the concentration authority sets — a " +
          "share off one or two invoices misleads more than it informs.",
        kind: "heuristic",
        drillThrough: drill,
      });
    } else {
      const top1 = input.concentration.top1SharePct;
      const band: CommercialRiskBand = input.concentration.concentrated
        ? top1 != null && top1 >= thresholds.concentrationHighPct
          ? "high"
          : "watch"
        : "ok";
      factors.push({
        key: "concentration",
        label: COMMERCIAL_FACTOR_LABEL.concentration,
        band,
        detail: input.concentration.concentrated
          ? (input.concentration.flaggedBecause ?? "Revenue is concentrated in few customers.")
          : `Top customer is ${top1 != null ? `${top1}%` : "a small share"} of revenue — not concentrated.`,
        basis:
          `High when one customer is ≥ ${thresholds.concentrationHighPct}% of invoiced revenue; ` +
          "watch when the concentration authority's flag fires below that. Losing a dominant " +
          "customer is a revenue cliff, not a gradual dip.",
        kind: "heuristic",
        drillThrough: drill,
      });
    }
  }

  // --- Overdue retention ---
  {
    const drill: EvidenceRef[] = [{ label: "Retention register", href: "/reports/retention" }];
    if (!input.retention) {
      factors.push(insufficient("retention_overdue", "Retention register couldn't be read.", drill));
    } else {
      const overdueJobs = input.retention.jobsOverdue;
      const claimable = input.retention.claimableNow;
      const band: CommercialRiskBand = overdueJobs > 0 ? "high" : "ok";
      factors.push({
        key: "retention_overdue",
        label: COMMERCIAL_FACTOR_LABEL.retention_overdue,
        band,
        detail:
          overdueJobs > 0
            ? `${fmtGbp(claimable)} claimable now across ${overdueJobs} job${overdueJobs === 1 ? "" : "s"} past a release date`
            : input.retention.heldTotal > 0
              ? `${fmtGbp(input.retention.heldTotal)} held, none yet past a release date`
              : "No retention currently held.",
        basis:
          "High when any job has a retention release date that has passed — money of yours another " +
          "party is holding that you are entitled to demand back. Held-but-not-yet-due retention is " +
          "not a risk, it is a future receivable, and is not flagged.",
        kind: "heuristic",
        drillThrough: drill,
      });
    }
  }

  // Fixed display order.
  factors.sort(
    (a, b) => COMMERCIAL_FACTOR_ORDER.indexOf(a.key) - COMMERCIAL_FACTOR_ORDER.indexOf(b.key),
  );

  return {
    factors,
    highCount: factors.filter((f) => f.band === "high").length,
    watchCount: factors.filter((f) => f.band === "watch").length,
    insufficientCount: factors.filter((f) => f.band === "insufficient").length,
  };
}

function insufficient(
  key: CommercialFactorKey,
  detail: string,
  drillThrough: EvidenceRef[],
): CommercialRiskFactor {
  return {
    key,
    label: COMMERCIAL_FACTOR_LABEL[key],
    band: "insufficient",
    detail,
    basis: "Absent data bands insufficient, never ok — a clean bill over an unread ledger is a lie.",
    kind: "heuristic",
    drillThrough,
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

export const COMMERCIAL_RISK_BAND_LABEL: Record<CommercialRiskBand, string> = {
  ok: "OK",
  watch: "Watch",
  high: "High",
  insufficient: "Not enough data",
};

export function commercialRiskMetric(
  board: CommercialRiskBoard,
): LabelledMetric<CommercialRiskBoard> {
  return labelled(board, {
    kind: "heuristic",
    basis:
      "Four independent financial-exposure factors — a projected cash shortfall, aged debt at " +
      "risk, customer concentration and overdue retention — each banded by its own rule (printed " +
      "on the factor). There is deliberately no single commercial-risk grade: the factors have " +
      "different units and no honest way to weigh one against another. A factor with nothing to " +
      "measure reads 'Not enough data', never OK.",
    computedFrom: [
      { label: "Cash", href: "/cash" },
      { label: "Aged debtors", href: "/reports/ageing" },
      { label: "Retention register", href: "/reports/retention" },
    ],
  });
}
