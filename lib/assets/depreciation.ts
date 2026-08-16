import { z } from "zod";

/**
 * Asset Management — P3W2: depreciation / net book value (PURE).
 *
 * Deterministic, side-effect-free depreciation maths. The DB
 * (20261145000000_asset_depreciation.sql) stores only the POLICY — method, cost,
 * salvage, start date, useful life / rate — and net book value (NBV) is COMPUTED
 * ON READ here, so a reported figure can never drift from the policy it derives
 * from. Two methods, both unit-tested on whole and partial periods:
 *
 *   straight_line     — writes (cost - salvage) off in equal monthly amounts
 *                       over useful_life_months, flooring at salvage.
 *   reducing_balance  — applies annual_rate_pct to the reducing carrying value
 *                       each year (partial current year prorated), flooring at
 *                       salvage (which it approaches asymptotically).
 *
 * Date-only arithmetic on ISO `YYYY-MM-DD` strings, UTC-anchored — no clocks in
 * here (callers pass "as of" / "today"), no DST traps. Money is carried as plain
 * numbers (GBP) and rounded to whole pence only at the boundary via `round2`.
 */

export const DEPRECIATION_METHODS = ["straight_line", "reducing_balance"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const DEPRECIATION_METHOD_LABELS: Record<DepreciationMethod, string> = {
  straight_line: "Straight line",
  reducing_balance: "Reducing balance",
};

/** The durable policy (mirrors asset_depreciation_settings). */
export type DepreciationPolicy = {
  method: DepreciationMethod;
  /** Depreciable cost basis. */
  cost: number;
  /** Residual value at end of life. */
  salvage_value: number;
  /** ISO YYYY-MM-DD: the day depreciation begins. */
  start_date: string;
  /** Straight-line: write-off period; reducing-balance: schedule horizon. */
  useful_life_months: number | null;
  /** Reducing-balance: annual depreciation percentage (e.g. 25). */
  annual_rate_pct: number | null;
};

export type NbvResult = {
  /** Carrying value as of the date, never below salvage. */
  nbv: number;
  /** cost - nbv. */
  accumulatedDepreciation: number;
  /** cost - salvage: the total that is ever written off. */
  depreciableBase: number;
  /** Elapsed months (real number, includes the partial current period). */
  elapsedMonths: number;
  /** True once the asset has reached (or is at) its salvage floor. */
  fullyDepreciated: boolean;
};

export type SchedulePeriod = {
  /** 1-based period number. */
  index: number;
  /** ISO date this period starts. */
  periodStart: string;
  /** "month" for straight-line, "year" for reducing-balance. */
  granularity: "month" | "year";
  openingValue: number;
  depreciation: number;
  accumulatedDepreciation: number;
  closingValue: number;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE_RE.test(v);
}

function toParts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Days in a given (1-based) month/year, UTC. */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Month addition with month-end clamping (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const { y, m, d } = toParts(iso);
  const last = daysInMonth(y, m + months);
  return fromUtc(new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))));
}

/**
 * Elapsed months between two ISO dates as a REAL number: whole months plus the
 * fraction of the current month elapsed by day-of-month. Never negative (an
 * as-of before the start yields 0). Deterministic and UTC-anchored.
 *
 * e.g. 2024-01-15 → 2024-02-15 = 1.0; 2024-01-15 → 2024-01-31 ≈ 0.516.
 */
export function elapsedMonthsBetween(startIso: string, asOfIso: string): number {
  if (!isIsoDate(startIso) || !isIsoDate(asOfIso)) return 0;
  const s = toParts(startIso);
  const a = toParts(asOfIso);
  const whole = (a.y - s.y) * 12 + (a.m - s.m);
  // Day fraction against the as-of month's length. Can be negative, which the
  // whole-months term absorbs (e.g. 15th → 10th of next month = 1 - frac).
  const frac = (a.d - s.d) / daysInMonth(a.y, a.m);
  const months = whole + frac;
  return months < 0 ? 0 : months;
}

/** Round to whole pence (2 dp), avoiding binary-float dust. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Net book value as of `asOfIso`. Pure; both methods floor at salvage. Returns a
 * carrying value rounded to whole pence.
 */
export function computeNbv(policy: DepreciationPolicy, asOfIso: string): NbvResult {
  const cost = policy.cost;
  const salvage = Math.min(policy.salvage_value, cost);
  const depreciableBase = round2(cost - salvage);
  const elapsedMonths = elapsedMonthsBetween(policy.start_date, asOfIso);

  let nbv: number;
  if (policy.method === "straight_line") {
    const life = policy.useful_life_months && policy.useful_life_months > 0 ? policy.useful_life_months : 1;
    const monthly = (cost - salvage) / life;
    const accumulated = clamp(monthly * elapsedMonths, 0, cost - salvage);
    nbv = cost - accumulated;
  } else {
    // Reducing balance: discrete annual steps, partial current year prorated.
    const r = (policy.annual_rate_pct ?? 0) / 100;
    const fullYears = Math.floor(elapsedMonths / 12);
    const partialYear = elapsedMonths / 12 - fullYears;
    let carrying = cost;
    for (let y = 0; y < fullYears; y++) {
      const dep = Math.min(carrying * r, carrying - salvage);
      carrying -= dep;
      if (carrying <= salvage) {
        carrying = salvage;
        break;
      }
    }
    if (carrying > salvage && partialYear > 0) {
      const dep = Math.min(carrying * r * partialYear, carrying - salvage);
      carrying -= dep;
    }
    nbv = carrying;
  }

  nbv = round2(Math.max(nbv, salvage));
  const accumulatedDepreciation = round2(cost - nbv);
  return {
    nbv,
    accumulatedDepreciation,
    depreciableBase,
    elapsedMonths,
    fullyDepreciated: nbv <= salvage + 0.005,
  };
}

/**
 * The full depreciation schedule — period-by-period rows from the start date.
 * Straight-line yields monthly rows over useful_life_months (the final row
 * absorbs rounding so closing lands exactly on salvage). Reducing-balance yields
 * annual rows over the horizon (useful_life_months rounded up to whole years,
 * default 5). Bounded and deterministic.
 */
export function depreciationSchedule(policy: DepreciationPolicy): SchedulePeriod[] {
  const cost = policy.cost;
  const salvage = Math.min(policy.salvage_value, cost);
  const rows: SchedulePeriod[] = [];

  if (policy.method === "straight_line") {
    const life = policy.useful_life_months && policy.useful_life_months > 0 ? policy.useful_life_months : 1;
    const monthly = round2((cost - salvage) / life);
    let carrying = cost;
    let accumulated = 0;
    for (let i = 0; i < life; i++) {
      const isLast = i === life - 1;
      // Last period absorbs rounding drift so closing == salvage exactly.
      const dep = isLast ? round2(carrying - salvage) : Math.min(monthly, round2(carrying - salvage));
      const opening = carrying;
      carrying = round2(carrying - dep);
      accumulated = round2(accumulated + dep);
      rows.push({
        index: i + 1,
        periodStart: addMonths(policy.start_date, i),
        granularity: "month",
        openingValue: round2(opening),
        depreciation: round2(dep),
        accumulatedDepreciation: accumulated,
        closingValue: carrying,
      });
      if (carrying <= salvage) break;
    }
    return rows;
  }

  // Reducing balance — annual rows.
  const r = (policy.annual_rate_pct ?? 0) / 100;
  const horizonYears = Math.max(1, Math.ceil((policy.useful_life_months ?? 60) / 12));
  let carrying = cost;
  let accumulated = 0;
  for (let i = 0; i < horizonYears; i++) {
    const dep = round2(Math.min(carrying * r, carrying - salvage));
    const opening = carrying;
    carrying = round2(carrying - dep);
    accumulated = round2(accumulated + dep);
    rows.push({
      index: i + 1,
      periodStart: addMonths(policy.start_date, i * 12),
      granularity: "year",
      openingValue: round2(opening),
      depreciation: dep,
      accumulatedDepreciation: accumulated,
      closingValue: carrying,
    });
    if (carrying <= salvage + 0.005) break;
  }
  return rows;
}

// ── Validation ────────────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const ISO = z
  .string()
  .trim()
  .regex(ISO_DATE_RE, "Use the date picker — format must be YYYY-MM-DD");

const money = z.preprocess(
  blankToUndefined,
  z.coerce.number().min(0).max(1_000_000_000),
);
const optMoney = z.preprocess(
  blankToUndefined,
  z.coerce.number().min(0).max(1_000_000_000).optional(),
);
const optInt = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).optional());
const optRate = z.preprocess(
  blankToUndefined,
  z.coerce.number().gt(0).max(100).optional(),
);

/**
 * Input schema for saving a policy. Method-conditional required parameters are
 * enforced here (mirroring the DB CHECK), plus salvage ≤ cost.
 */
export const depreciationPolicySchema = z
  .object({
    asset_id: z.string().uuid(),
    method: z.enum(DEPRECIATION_METHODS),
    cost: money,
    salvage_value: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1_000_000_000).default(0)),
    start_date: ISO,
    useful_life_months: optInt(1, 1200),
    annual_rate_pct: optRate,
  })
  .superRefine((v, ctx) => {
    if (v.method === "straight_line" && v.useful_life_months == null) {
      ctx.addIssue({ code: "custom", message: "Give the useful life in months", path: ["useful_life_months"] });
    }
    if (v.method === "reducing_balance" && v.annual_rate_pct == null) {
      ctx.addIssue({ code: "custom", message: "Give the annual depreciation rate", path: ["annual_rate_pct"] });
    }
    if (v.salvage_value > v.cost) {
      ctx.addIssue({ code: "custom", message: "Salvage value can't exceed cost", path: ["salvage_value"] });
    }
  });
export type DepreciationPolicyInput = z.infer<typeof depreciationPolicySchema>;

/** avoid an unused-import lint for optMoney (kept for symmetry / future use). */
void optMoney;

export function friendlyDepreciationError(code: string | undefined, message: string | undefined): string {
  if (code === "23514" || code === "check_violation") {
    if (message && /method_params/.test(message)) {
      return "Each method needs its own parameter — a useful life (straight line) or a rate (reducing balance).";
    }
    if (message && /salvage_le_cost/.test(message)) {
      return "Salvage value can't exceed the cost.";
    }
    if (message && /not in org/.test(message)) {
      return "That asset isn't in your organisation.";
    }
    return "Those depreciation settings aren't allowed.";
  }
  return "Couldn't save the depreciation settings. Try again.";
}
