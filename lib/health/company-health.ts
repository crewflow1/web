import { round2 } from "@/lib/money";
import { averageMargin, type JobProfitability } from "@/lib/profitability/compute";
import type { AgedDebtSummary, RetentionExposure } from "@/lib/intelligence/exposure";
import type { CvrRollup } from "@/lib/intelligence/cvr-rollup";
import type { ProgressRollup } from "@/lib/intelligence/progress-rollup";
import type { ProgrammeVarianceRollup } from "@/lib/intelligence/programme-variance";
import type { SupplierPerformanceRollup } from "@/lib/intelligence/supplier-performance";
import { isRated } from "@/lib/suppliers/performance";
import type { HsSnapshot } from "@/lib/health-safety/signals";
import type { EvidenceRef, SignalKind } from "@/lib/intelligence/provenance";

/**
 * COMPANY HEALTH — a PER-DIMENSION RAG view. PURE.
 *
 * ── WHY THIS LIVES IN lib/health, NOT lib/intelligence ──────────────────────
 * lib/intelligence/** carries a TEST-ENFORCED anti-composite-score ratchet
 * (__tests__/intelligence/source-assertions.test.ts): the directory is grepped
 * for the four blended-score identifiers (overall-, health-, composite- and
 * weighted-score, camel-cased) and a PR that adds one goes red — and
 * __tests__/health/ratchet-compat.test.ts extends the same grep to THIS
 * directory. That ratchet exists because a single blended
 * "health score" is a lie with a denominator — it decides that one late supplier
 * is worth N days of overdue debt, and nothing in this database knows that
 * exchange rate (lib/suppliers/performance.ts header points 1–2). This module
 * honours that doctrine rather than evading it: it sits in a sibling directory
 * precisely so it CANNOT reach for a blended number, and it never computes one.
 * There is NO overall band, NO score, NO weighting anywhere below — only five
 * INDEPENDENT dimensions, each banded by ONE authority family with its own
 * denominator, each printing the exact rule that fired.
 *
 * ── THE ONE HONESTY RULE THAT OUTRANKS EVERYTHING ───────────────────────────
 * Absence of data is `insufficient`, NEVER green. A dimension with nothing to
 * measure must say so — a green light over an empty ledger is the single most
 * dangerous output a health view can produce, and it is especially dangerous
 * for SAFETY: an org that has recorded no risk assessments and no permits has
 * not proven it is safe, it has proven nothing, and this module refuses to paint
 * that green. The `insufficient` band is a first-class answer, not an error.
 *
 * ── KIND ────────────────────────────────────────────────────────────────────
 * Every dimension is a HEURISTIC: the band is a JUDGEMENT RULE (a threshold
 * somebody chose) applied to derived figures, so each carries `kind:
 * "heuristic"` and prints its rule verbatim in `basis` — the provenance doctrine
 * (lib/intelligence/provenance.ts). The underlying figures are derived by the
 * authorities this composes; the banding is the only opinion added, and it is
 * stated, not hidden.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────
 * No I/O, no clock. It takes the ALREADY-FETCHED authority outputs (the
 * lib/briefing/compose.ts pattern) and decides nothing about money — every
 * figure is read from an authority that owns it. A failed group arrives as
 * `null` and bands `insufficient`: a read that failed is not a clean bill of
 * health.
 */

// ---------------------------------------------------------------------------
// The bands and the dimensions
// ---------------------------------------------------------------------------

export type HealthBand = "green" | "amber" | "red" | "insufficient";

export type HealthDimensionKey =
  | "cash"
  | "delivery"
  | "safety"
  | "supplier"
  | "profitability";

/** Fixed render order, worst-consequence dimensions first. */
export const HEALTH_DIMENSION_ORDER: readonly HealthDimensionKey[] = [
  "safety",
  "cash",
  "delivery",
  "profitability",
  "supplier",
] as const;

export const HEALTH_DIMENSION_LABEL: Record<HealthDimensionKey, string> = {
  cash: "Cash & Commercial",
  delivery: "Delivery & Schedule",
  safety: "Safety",
  supplier: "Supplier",
  profitability: "Profitability",
};

export interface HealthDimension {
  key: HealthDimensionKey;
  label: string;
  band: HealthBand;
  /** The exact rule that produced the band, in plain English. Always present. */
  basis: string;
  /** Always "heuristic": the band is a chosen threshold, stated in `basis`. */
  kind: SignalKind;
  /** Where to go to check the figures behind the band. */
  drillThrough: EvidenceRef[];
}

export interface CompanyHealth {
  /** The five dimensions, in HEALTH_DIMENSION_ORDER. NO overall band exists. */
  dimensions: HealthDimension[];
}

// ---------------------------------------------------------------------------
// The thresholds — the decision-as-config seam
// ---------------------------------------------------------------------------

/**
 * The banding thresholds, gathered in ONE place on purpose.
 *
 * CEO ratifies these values — changing them is CONFIG, not code. Where the red
 * line for 90-day debt sits, or how many jobs behind plan is "red", is a
 * business risk-appetite decision, not an engineering one; it belongs to whoever
 * owns the company's risk posture, and it must be changeable without a code
 * review of the banding logic. The rules that CONSUME these numbers are code and
 * are tested; the numbers themselves are a ratifiable policy that lives here so
 * the seam between the two is explicit rather than buried in an `if`.
 *
 * Every value is quoted verbatim in the `basis` string of the band it drives, so
 * a reader never has to trust that the printed rule matches the code.
 */
export const DEFAULT_HEALTH_THRESHOLDS = {
  cash: {
    /** Red when this % or more of what you are owed is 90+ days overdue. */
    over90SharePctRed: 20,
  },
  delivery: {
    /** Red when this many or more live jobs are behind their baseline. */
    behindBaselineRed: 3,
    /** Amber when at least this many live jobs are behind their baseline. */
    behindBaselineAmber: 1,
    /** Red when this many or more planned milestones are past their date. */
    overdueMilestonesRed: 5,
  },
  supplier: {
    /** Red when the org-wide LATE delivery rate reaches this %. */
    orgLatePctRed: 40,
    /** Amber when the org-wide LATE delivery rate reaches this %. */
    orgLatePctAmber: 20,
  },
  profitability: {
    /** Red when average job margin is below this %. */
    redMarginPct: 15,
    /** Green when average job margin is at or above this %; amber between. */
    greenMarginPct: 30,
  },
} as const;

export type HealthThresholds = typeof DEFAULT_HEALTH_THRESHOLDS;

// ---------------------------------------------------------------------------
// The input — already-fetched authority outputs, one per group
// ---------------------------------------------------------------------------

/**
 * A group is `null` when its read FAILED or was unavailable. Null always bands
 * `insufficient`: a failed read is not evidence of health.
 */
export interface CompanyHealthInput {
  cash: {
    agedDebt: AgedDebtSummary;
    retention: RetentionExposure;
    cvr: CvrRollup;
  } | null;
  delivery: {
    progress: ProgressRollup;
    programme: ProgrammeVarianceRollup;
  } | null;
  safety: {
    snapshot: HsSnapshot;
    /**
     * True when the org has ANY health-and-safety record at all — an issued or
     * draft risk assessment, a permit, or an in-progress job that ought to carry
     * one. Without this, an all-zero snapshot is indistinguishable from a
     * genuinely all-clear one, and the safe reading of that ambiguity is
     * `insufficient`, never green.
     */
    hasAnySafetyRecord: boolean;
  } | null;
  supplier: SupplierPerformanceRollup | null;
  /** Every job with revenue or cost (the profitability authority's own rows). */
  profitability: JobProfitability[] | null;
}

// ---------------------------------------------------------------------------
// Per-dimension band rules
// ---------------------------------------------------------------------------

const gbp = (n: number): string =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);

function cashDimension(
  input: CompanyHealthInput["cash"],
  t: HealthThresholds,
): HealthDimension {
  const base = {
    key: "cash" as const,
    label: HEALTH_DIMENSION_LABEL.cash,
    kind: "heuristic" as const,
    drillThrough: [
      { label: "Aged debtors", href: "/reports/ageing" },
      { label: "Budget forecasts", href: "/insights" },
    ],
  };
  if (!input) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: the cash and commercial reads didn't complete, so nothing is banded — a failed read is not a clean bill of health.",
    };
  }
  const { agedDebt, cvr } = input;
  const nothingOwed = agedDebt.total <= 0;
  const noBudgets = cvr.jobsWithBudget === 0;
  if (nothingOwed && noBudgets) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: nothing is currently owed to you and no live job carries a cost budget, so there is nothing to assess yet.",
    };
  }

  // Red share of 90+ day debt (only meaningful when something is owed). Compare on
  // the UNROUNDED ratio so the red line trips at exactly the threshold, not ~0.5%
  // early; the rounded figure is for display only.
  const over90Ratio = agedDebt.total > 0 ? (agedDebt.over90 / agedDebt.total) * 100 : 0;
  const over90Pct = Math.round(over90Ratio);
  const over90Red = agedDebt.total > 0 && over90Ratio >= t.cash.over90SharePctRed;
  const forecastOverBudget = cvr.redCount > 0;

  if (over90Red || forecastOverBudget) {
    const reasons: string[] = [];
    if (over90Red) {
      reasons.push(
        `${gbp(agedDebt.over90)} of ${gbp(agedDebt.total)} owed (${over90Pct}%) is 90+ days overdue — at or above the ${t.cash.over90SharePctRed}% red line`,
      );
    }
    if (forecastOverBudget) {
      reasons.push(
        `${cvr.redCount} budgeted job${cvr.redCount === 1 ? "" : "s"} already forecast over budget`,
      );
    }
    return { ...base, band: "red", basis: `Red: ${reasons.join("; ")}.` };
  }

  const anyPastDue = agedDebt.pastDue > 0;
  const anyTight = cvr.amberCount > 0;
  if (anyPastDue || anyTight) {
    const reasons: string[] = [];
    if (anyPastDue) reasons.push(`${gbp(agedDebt.pastDue)} is past its due date`);
    if (anyTight)
      reasons.push(
        `${cvr.amberCount} budgeted job${cvr.amberCount === 1 ? "" : "s"} within 10% of budget`,
      );
    return {
      ...base,
      band: "amber",
      basis: `Amber: ${reasons.join("; ")} — below the ${t.cash.over90SharePctRed}% 90-day red line, but worth watching.`,
    };
  }

  return {
    ...base,
    band: "green",
    basis: `Green: nothing is past due and no budgeted job's forecast is over or within 10% of budget. ${gbp(agedDebt.total)} owed, all current.`,
  };
}

function deliveryDimension(
  input: CompanyHealthInput["delivery"],
  t: HealthThresholds,
): HealthDimension {
  const base = {
    key: "delivery" as const,
    label: HEALTH_DIMENSION_LABEL.delivery,
    kind: "heuristic" as const,
    drillThrough: [
      { label: "Job progress & programme", href: "/insights" },
      { label: "Jobs", href: "/jobs" },
    ],
  };
  if (!input) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: the progress and programme reads didn't complete, so nothing is banded.",
    };
  }
  const { progress, programme } = input;
  const noLiveJobs = programme.jobsConsidered === 0 && progress.activeJobs === 0;
  if (noLiveJobs) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: no jobs are in progress and none are live against a plan, so schedule health can't be assessed.",
    };
  }
  // If there ARE live jobs but NONE has a baseline and NONE has a reading, the
  // schedule simply isn't being tracked — that is not green, it is insufficient.
  const noPlan = programme.jobsWithBaseline === 0;
  const noReadings = progress.assessedJobs === 0;
  if (noPlan && noReadings) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: live jobs exist, but none carries a programme baseline and none has a progress reading — there is nothing to measure delivery against yet.",
    };
  }

  const behind = programme.behindBaseline.length;
  const overdueMilestones = programme.overdueMilestoneCount;
  if (behind >= t.delivery.behindBaselineRed || overdueMilestones >= t.delivery.overdueMilestonesRed) {
    const reasons: string[] = [];
    if (behind >= t.delivery.behindBaselineRed)
      reasons.push(`${behind} live jobs behind baseline (red at ${t.delivery.behindBaselineRed})`);
    if (overdueMilestones >= t.delivery.overdueMilestonesRed)
      reasons.push(
        `${overdueMilestones} milestones past their planned date (red at ${t.delivery.overdueMilestonesRed})`,
      );
    return { ...base, band: "red", basis: `Red: ${reasons.join("; ")}.` };
  }

  const stalled = progress.stalled.length;
  const regressing = progress.regressing.length;
  if (
    behind >= t.delivery.behindBaselineAmber ||
    overdueMilestones > 0 ||
    stalled > 0 ||
    regressing > 0
  ) {
    const reasons: string[] = [];
    if (behind >= t.delivery.behindBaselineAmber)
      reasons.push(`${behind} live job${behind === 1 ? "" : "s"} behind baseline`);
    if (overdueMilestones > 0)
      reasons.push(`${overdueMilestones} milestone${overdueMilestones === 1 ? "" : "s"} past date`);
    if (stalled > 0) reasons.push(`${stalled} stalled`);
    if (regressing > 0) reasons.push(`${regressing} went backwards`);
    return {
      ...base,
      band: "amber",
      basis: `Amber: ${reasons.join(", ")} — under the red thresholds (${t.delivery.behindBaselineRed} behind or ${t.delivery.overdueMilestonesRed} overdue milestones).`,
    };
  }

  return {
    ...base,
    band: "green",
    basis: "Green: no live job is behind its baseline, no milestone is past its date, and nothing has stalled or gone backwards.",
  };
}

function safetyDimension(input: CompanyHealthInput["safety"]): HealthDimension {
  const base = {
    key: "safety" as const,
    label: HEALTH_DIMENSION_LABEL.safety,
    kind: "heuristic" as const,
    drillThrough: [
      { label: "Health & Safety", href: "/health-safety" },
      { label: "Permits", href: "/health-safety/permits" },
    ],
  };
  if (!input) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: the health-and-safety reads didn't complete, so nothing is banded — and a failed safety read is never treated as safe.",
    };
  }
  // THE CRITICAL RULE. No H&S records at all ⇒ we know nothing, which is NOT the
  // same as knowing all is well. An all-zero snapshot over an empty programme
  // must NEVER read green.
  if (!input.hasAnySafetyRecord) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: no risk assessments, permits or active jobs on record — there is no evidence to judge safety on, and absence of records is never a pass.",
    };
  }
  const s = input.snapshot;
  // RED — a LIVE breach: an active job with no current RAMS, or a permit past
  // expiry but still open. Both are live legal exposures (the briefing's
  // `critical` block), not warnings.
  if (s.activeJobsNoCurrentRams > 0 || s.permitsExpiredLive > 0) {
    const reasons: string[] = [];
    if (s.activeJobsNoCurrentRams > 0)
      reasons.push(
        `${s.activeJobsNoCurrentRams} active job${s.activeJobsNoCurrentRams === 1 ? "" : "s"} with no current RAMS`,
      );
    if (s.permitsExpiredLive > 0)
      reasons.push(
        `${s.permitsExpiredLive} permit${s.permitsExpiredLive === 1 ? "" : "s"} expired but still open`,
      );
    return { ...base, band: "red", basis: `Red: ${reasons.join("; ")} — a live legal exposure.` };
  }
  // AMBER — warnings that need action but are not a live breach.
  const amber =
    s.permitsExpiringSoon +
    s.ramsReviewOverdue +
    s.highResidualRams +
    s.toolboxAwaitingAck +
    s.ramsDraft;
  if (amber > 0) {
    const reasons: string[] = [];
    if (s.permitsExpiringSoon > 0) reasons.push(`${s.permitsExpiringSoon} permit(s) expiring within 24h`);
    if (s.ramsReviewOverdue > 0) reasons.push(`${s.ramsReviewOverdue} RAMS past review date`);
    if (s.highResidualRams > 0) reasons.push(`${s.highResidualRams} RAMS with a critical residual risk`);
    if (s.toolboxAwaitingAck > 0) reasons.push(`${s.toolboxAwaitingAck} toolbox talk(s) awaiting sign-off`);
    if (s.ramsDraft > 0) reasons.push(`${s.ramsDraft} draft RAMS awaiting issue`);
    return { ...base, band: "amber", basis: `Amber: ${reasons.join(", ")} — no live breach, but action is due.` };
  }
  return {
    ...base,
    band: "green",
    basis: "Green: a health-and-safety programme is on record, and there is no expired permit, no active job without a current RAMS, no overdue review, and no critical residual risk.",
  };
}

function supplierDimension(
  input: CompanyHealthInput["supplier"],
  t: HealthThresholds,
): HealthDimension {
  const base = {
    key: "supplier" as const,
    label: HEALTH_DIMENSION_LABEL.supplier,
    kind: "heuristic" as const,
    drillThrough: [
      { label: "Compare suppliers", href: "/suppliers/compare" },
      { label: "Suppliers", href: "/suppliers" },
    ],
  };
  if (!input) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: the supplier-performance read didn't complete, so nothing is banded.",
    };
  }
  if (input.suppliersWithRecord === 0) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: no supplier has any measurable trading history yet — a record appears once an order is delivered or a bill is linked.",
    };
  }

  const overBillFlags = input.overBillingFlags.length;
  const slowFlags = input.slowSettlementFlags.length;
  const orgLate = input.orgPunctuality;
  // The org-wide late rate is only banded once the SAMPLE has earned a rate
  // (the MIN_RATED_SAMPLE floor travels through); below that it never colours
  // the dimension, so a rate the data hasn't earned can't drive the band.
  const orgLatePct = isRated(orgLate) ? orgLate.pct : null;

  const lateRed = orgLatePct != null && orgLatePct >= t.supplier.orgLatePctRed;
  if (lateRed || overBillFlags > 0) {
    const reasons: string[] = [];
    if (lateRed)
      reasons.push(
        `${orgLatePct}% of judgeable deliveries were late (red at ${t.supplier.orgLatePctRed}%)`,
      );
    if (overBillFlags > 0)
      reasons.push(
        `${overBillFlags} supplier${overBillFlags === 1 ? "" : "s"} flagged for over-invoicing`,
      );
    return { ...base, band: "red", basis: `Red: ${reasons.join("; ")}.` };
  }

  const lateAmber = orgLatePct != null && orgLatePct >= t.supplier.orgLatePctAmber;
  if (lateAmber || slowFlags > 0) {
    const reasons: string[] = [];
    if (lateAmber)
      reasons.push(
        `${orgLatePct}% of judgeable deliveries were late (amber at ${t.supplier.orgLatePctAmber}%)`,
      );
    if (slowFlags > 0)
      reasons.push(
        `${slowFlags} supplier${slowFlags === 1 ? "" : "s"} we settle slowly (a retention risk)`,
      );
    return { ...base, band: "amber", basis: `Amber: ${reasons.join("; ")} — under the ${t.supplier.orgLatePctRed}% red line.` };
  }

  const rateLabel = orgLatePct != null ? `${orgLatePct}% late` : "too few judgeable deliveries to rate";
  return {
    ...base,
    band: "green",
    basis: `Green: org-wide delivery is ${rateLabel} (under the ${t.supplier.orgLatePctAmber}% amber line), and no supplier crosses the over-invoicing or slow-settlement thresholds.`,
  };
}

function profitabilityDimension(
  input: CompanyHealthInput["profitability"],
  t: HealthThresholds,
): HealthDimension {
  const base = {
    key: "profitability" as const,
    label: HEALTH_DIMENSION_LABEL.profitability,
    kind: "heuristic" as const,
    drillThrough: [
      { label: "Finances", href: "/finances" },
      { label: "Invoices", href: "/invoices" },
    ],
  };
  if (!input) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: the profitability read didn't complete, so nothing is banded.",
    };
  }
  const withRevenue = input.filter((r) => r.margin_pct !== null).length;
  const avg = averageMargin(input);
  if (withRevenue === 0 || avg === null) {
    return {
      ...base,
      band: "insufficient",
      basis: "Insufficient: no job has invoiced revenue yet, so there is no margin to band.",
    };
  }
  // The caveat travels WITH the band: margin here is invoiced revenue against
  // recorded costs. Labour time not yet posted as a cost is excluded, so the
  // true margin can only be the same or LOWER — which is why a healthy figure
  // here is banded conservatively and the caveat is printed.
  const caveat =
    "Margin is invoiced revenue against recorded costs; labour time not yet posted as a cost is excluded, so the true figure can only be equal or lower.";

  if (avg < t.profitability.redMarginPct) {
    return {
      ...base,
      band: "red",
      basis: `Red: average job margin is ${avg}% across ${withRevenue} job${withRevenue === 1 ? "" : "s"} with revenue — below the ${t.profitability.redMarginPct}% red line. ${caveat}`,
    };
  }
  if (avg < t.profitability.greenMarginPct) {
    return {
      ...base,
      band: "amber",
      basis: `Amber: average job margin is ${avg}% across ${withRevenue} job${withRevenue === 1 ? "" : "s"} with revenue — between the ${t.profitability.redMarginPct}% red and ${t.profitability.greenMarginPct}% green lines. ${caveat}`,
    };
  }
  return {
    ...base,
    band: "green",
    basis: `Green: average job margin is ${avg}% across ${withRevenue} job${withRevenue === 1 ? "" : "s"} with revenue — at or above the ${t.profitability.greenMarginPct}% green line. ${caveat}`,
  };
}

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

/**
 * Band every dimension from already-fetched authority outputs. Deterministic:
 * the same inputs always produce the identical five bands, in the identical
 * order, and NEVER a blended overall number.
 */
export function computeCompanyHealth(
  input: CompanyHealthInput,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): CompanyHealth {
  const byKey: Record<HealthDimensionKey, HealthDimension> = {
    cash: cashDimension(input.cash, thresholds),
    delivery: deliveryDimension(input.delivery, thresholds),
    safety: safetyDimension(input.safety),
    supplier: supplierDimension(input.supplier, thresholds),
    profitability: profitabilityDimension(input.profitability, thresholds),
  };
  return { dimensions: HEALTH_DIMENSION_ORDER.map((k) => byKey[k]) };
}

// ---------------------------------------------------------------------------
// Display helpers (text + colour, never colour alone)
// ---------------------------------------------------------------------------

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  green: "Healthy",
  amber: "Watch",
  red: "Act now",
  insufficient: "Not enough data",
};

/** Tailwind classes for a band pill. Paired ALWAYS with the text label above. */
export function healthBandClass(band: HealthBand): string {
  switch (band) {
    case "green":
      return "bg-green-100 text-green-800 border-green-200";
    case "amber":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "red":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

/** Round a share to a whole percent, guarding a zero denominator. */
export function sharePct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return round2(Math.round((part / whole) * 100));
}
