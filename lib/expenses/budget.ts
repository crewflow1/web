import { formatDayKeyUK } from "@/lib/time/format";
import { FINANCE_CATEGORIES, type FinanceCategory } from "@/lib/finances/schema";

/**
 * Expense budget-vs-actual — an ORG / CATEGORY operational spend overlay. PURE
 * and DETERMINISTIC: budgets + spend + a fixed instant in, figures out. No
 * client, no clock (the caller passes `now`), no AI.
 *
 * ── THE ACCOUNTING BOUNDARY ─────────────────────────────────────────────────
 * A budget is a PLAN, never a transaction. This module READS spend and COMPARES
 * it with the plan; it never writes anywhere. A planned figure reaching
 * `finances` (the actual-cost ledger) would be double-counted against the real
 * spend the moment it was entered — the double-count hazard operational stock
 * shipped on (CEO decision D1) and the one `job_budgets` was built to avoid.
 * This module does not even NAME the ledger: spend arrives already-shaped as
 * arguments. Swept by __tests__/security/expense-budgets.test.ts.
 *
 * ── DISTINCT FROM lib/jobs/budget.ts (job_budgets) ──────────────────────────
 * That module is a PER-JOB cost baseline — one job's priced cost vs its actual
 * and forecast. This is ORG-WIDE, PER-CATEGORY operational spend vs a standing
 * target. Different tables, different questions, no shared code.
 *
 * ── UNITS: INTEGER PENCE THROUGHOUT ─────────────────────────────────────────
 * Budgets are stored as `amount_pence` (BIGINT). Actual spend arrives as
 * `finances.amount` in POUNDS (numeric) and is converted to pence HERE, at the
 * boundary, via `poundsToPence` — so every variance is integer-vs-integer with
 * no float drift. Callers hand raw `finances` rows; nothing upstream must
 * pre-convert.
 *
 * ── THE PERIOD MODEL ────────────────────────────────────────────────────────
 * Each budget carries a `period_type` in {monthly, quarterly, annual} and is a
 * STANDING target that recurs each period. The CURRENT period is anchored to the
 * Europe/London CALENDAR against the passed `now`: monthly = current London
 * month, quarterly = current London calendar quarter, annual = current London
 * year. A spend row counts toward a category's line iff its effective London day
 * falls inside THAT category's current period window.
 *
 * Because different categories can carry different cadences, each line reports
 * its OWN period window and label; there is no single page-wide period. Callers
 * that fetch spend need only cover the widest current window — the current
 * London calendar YEAR-to-date contains every current monthly, quarterly and
 * annual window — see `currentYearStartDayKey`.
 *
 * London-pinning lives inside this module (not `now.toISOString()` month math):
 * `formatDayKeyUK` gives the Europe/London calendar day of any instant, so a
 * 23:30 BST spend on 31 July buckets into July, not the UTC 30-June-or-1-August
 * a naive slice would produce. Tested with a frozen BST instant.
 */

export type ExpenseCategory = FinanceCategory;
export type PeriodType = "monthly" | "quarterly" | "annual";

/** An `expense_budgets` row, as read. */
export type ExpenseBudgetRow = {
  category: string;
  amount_pence: number | string | null;
  period_type: string | null;
  note: string | null;
  updated_at: string | null;
};

/**
 * A `finances` row reduced to what the overlay needs. `amount` is POUNDS (the
 * numeric column). The effective spend date is `bill_date` (the date printed on
 * the supplier invoice, a plain calendar date) when present, else the London
 * calendar day of `created_at` — the same ageing-date rule aged-creditors uses,
 * and for the same reason (a bill entered at 23:30 BST belongs to that day).
 */
export type ExpenseSpendRow = {
  category: string | null;
  amount: number | string | null;
  bill_date: string | null;
  created_at: string | null;
};

/**
 * A category with spend but no budget, or a budgeted category — either way the
 * band is honest.
 *
 *   no_budget — no target set. Spend is real and surfaced; variance is not a
 *               figure (a £0 target would read "100 % over").
 *   under     — utilisation ≤ 80 % of the target. Comfortable headroom.
 *   near      — 80 % < utilisation ≤ 100 %. Approaching or at the limit.
 *   over      — utilisation > 100 %. The target is exceeded.
 */
export type BudgetBand = "no_budget" | "under" | "near" | "over";

/** The band thresholds, as utilisation (actual / budget × 100). Stated once. */
export const NEAR_THRESHOLD_PCT = 80;
export const OVER_THRESHOLD_PCT = 100;

export type CategoryBudgetLine = {
  category: ExpenseCategory;
  /** True when a target is set for this category. */
  hasBudget: boolean;
  /** The target, integer pence. null when no target is set. */
  budgetPence: number | null;
  /** Actual spend in this category's current period, integer pence. */
  actualPence: number;
  /** budget − actual, integer pence. Positive = headroom left. null without a target. */
  variancePence: number | null;
  /** actual / budget × 100, 2dp. null without a target. */
  utilisationPct: number | null;
  band: BudgetBand;
  /** The cadence this line's window was computed for (defaults monthly when unbudgeted). */
  periodType: PeriodType;
  /** Human label for the current window, e.g. "August 2026", "Q3 2026", "2026". */
  periodLabel: string;
};

export type ExpenseBudgetSummary = {
  lines: CategoryBudgetLine[];
  /** Σ target pence over categories that HAVE a target. */
  totalBudgetPence: number;
  /** Σ actual pence over categories that HAVE a target, in each one's window. */
  totalBudgetedActualPence: number;
  /** Σ actual pence in categories with NO target set (surfaced, not dropped). */
  unbudgetedActualPence: number;
  /** True when set budgets span more than one cadence — a grand total mixes windows. */
  mixedPeriods: boolean;
  /** Any category over its target. */
  anyOver: boolean;
};

/** Pounds (numeric/string/null) → integer pence, drift-free. */
export function poundsToPence(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toPenceInt(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function normalisePeriod(v: string | null | undefined): PeriodType {
  return v === "quarterly" || v === "annual" ? v : "monthly";
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The effective London calendar day (`YYYY-MM-DD`) a spend row falls on:
 * `bill_date` verbatim when present (it is already a calendar date with no time
 * or zone), else the Europe/London day of `created_at`. "" when neither yields a
 * usable date — such a row counts toward no period.
 */
export function spendDayKey(row: ExpenseSpendRow): string {
  const bill = (row.bill_date ?? "").trim();
  if (bill) return bill.slice(0, 10);
  return formatDayKeyUK(row.created_at);
}

/** The Europe/London calendar quarter (1-4) of a `YYYY-MM` key's month. */
function quarterOf(monthKey: string): number {
  const m = Number(monthKey.slice(5, 7));
  return Math.floor((m - 1) / 3) + 1;
}

/**
 * Is `dayKey` (YYYY-MM-DD) inside the CURRENT `period` window derived from
 * `nowDayKey` (also YYYY-MM-DD, the London day of `now`)? Pure string maths on
 * ISO keys — they sort chronologically, so no Date arithmetic is needed.
 */
function inCurrentPeriod(dayKey: string, nowDayKey: string, period: PeriodType): boolean {
  if (!dayKey || !nowDayKey) return false;
  const nowYear = nowDayKey.slice(0, 4);
  if (period === "annual") return dayKey.slice(0, 4) === nowYear;
  if (period === "monthly") return dayKey.slice(0, 7) === nowDayKey.slice(0, 7);
  // quarterly: same London year AND same calendar quarter.
  return (
    dayKey.slice(0, 4) === nowYear &&
    quarterOf(dayKey.slice(0, 7)) === quarterOf(nowDayKey.slice(0, 7))
  );
}

/** The human label for the current window of `period`, from the London `now` day. */
export function periodLabel(nowDayKey: string, period: PeriodType): string {
  const year = nowDayKey.slice(0, 4);
  if (period === "annual") return year;
  if (period === "quarterly") return `Q${quarterOf(nowDayKey.slice(0, 7))} ${year}`;
  const monthIdx = Number(nowDayKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIdx] ?? nowDayKey.slice(0, 7)} ${year}`;
}

/**
 * The first London day of the current calendar YEAR, as `YYYY-MM-DD`. The floor
 * a spend fetch needs: every current monthly / quarterly / annual window lies at
 * or after it, so a caller fetching `bill_date >= this OR created_at >= <its UTC
 * start>` covers every line. Exposed so the read layer never re-derives it.
 */
export function currentYearStartDayKey(now: Date | string | number): string {
  return `${formatDayKeyUK(now).slice(0, 4)}-01-01`;
}

function band(utilisationPct: number | null): BudgetBand {
  if (utilisationPct === null) return "no_budget";
  if (utilisationPct > OVER_THRESHOLD_PCT) return "over";
  if (utilisationPct > NEAR_THRESHOLD_PCT) return "near";
  return "under";
}

/**
 * Compose the budget-vs-actual overlay for one org.
 *
 * Every one of the eight known categories gets a line, in FINANCE_CATEGORIES
 * order. A category with a budget bands against it; a category with spend but no
 * budget surfaces the spend honestly (band `no_budget`, variance null) rather
 * than dropping it or inventing a £0 target. Spend whose `finances.category` is
 * null or outside the known set is NOT attributed to any category line and NOT
 * invented into one: a budget can only be set against a known category, and
 * re-homing unknown spend into `misc` would be a fabricated figure. Such spend
 * stays visible in the raw ledger; this overlay simply does not claim a budget
 * line owns it.
 */
export function computeExpenseBudgetPosition(input: {
  budgets: ExpenseBudgetRow[];
  spend: ExpenseSpendRow[];
  now: Date | string | number;
}): ExpenseBudgetSummary {
  const nowDayKey = formatDayKeyUK(input.now);

  // Index budgets by category (the DB unique key guarantees ≤1 per category;
  // if a hand-written duplicate ever appears, the last wins deterministically).
  const budgetByCategory = new Map<string, ExpenseBudgetRow>();
  for (const b of input.budgets) budgetByCategory.set(b.category, b);

  const known = new Set<string>(FINANCE_CATEGORIES);

  const lines: CategoryBudgetLine[] = FINANCE_CATEGORIES.map((category) => {
    const budgetRow = budgetByCategory.get(category) ?? null;
    const hasBudget = budgetRow !== null;
    const period = normalisePeriod(budgetRow?.period_type);

    // Actual = Σ spend in THIS category, inside this line's current window.
    let actualPence = 0;
    for (const s of input.spend) {
      if ((s.category ?? "") !== category) continue;
      if (!inCurrentPeriod(spendDayKey(s), nowDayKey, period)) continue;
      actualPence += poundsToPence(s.amount);
    }

    const budgetPence = hasBudget ? toPenceInt(budgetRow!.amount_pence) : null;
    const variancePence = budgetPence === null ? null : budgetPence - actualPence;
    const utilisationPct =
      budgetPence === null || budgetPence === 0
        ? null
        : Math.round((actualPence / budgetPence) * 100 * 100) / 100;

    return {
      category,
      hasBudget,
      budgetPence,
      actualPence,
      variancePence,
      utilisationPct,
      band: band(utilisationPct),
      periodType: period,
      periodLabel: periodLabel(nowDayKey, period),
    };
  });

  // Unbudgeted spend: any spend in a KNOWN category with no target, in that
  // category's default (monthly) current window — plus unknown/null-category
  // spend is deliberately excluded (see doc-comment) so we never fabricate a
  // home for it.
  let totalBudgetPence = 0;
  let totalBudgetedActualPence = 0;
  let unbudgetedActualPence = 0;
  const cadences = new Set<PeriodType>();
  let anyOver = false;

  for (const line of lines) {
    if (line.hasBudget) {
      totalBudgetPence += line.budgetPence ?? 0;
      totalBudgetedActualPence += line.actualPence;
      cadences.add(line.periodType);
      if (line.band === "over") anyOver = true;
    } else {
      unbudgetedActualPence += line.actualPence;
    }
  }

  void known; // documents intent: only known categories get lines.

  return {
    lines,
    totalBudgetPence,
    totalBudgetedActualPence,
    unbudgetedActualPence,
    mixedPeriods: cadences.size > 1,
    anyOver,
  };
}
