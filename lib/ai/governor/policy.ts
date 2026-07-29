/**
 * AI Cost Governor — the PURE decision core.
 *
 * The ceiling, the warning thresholds, the spike rule, the month window, the
 * dedupe fingerprint and the cost estimator. Every one is a total function of
 * its arguments: no clock it did not receive, no database, no environment, no
 * `server-only`. That is what makes the £100 ceiling testable at the exact
 * boundaries it is supposed to hold at, rather than only observable in
 * production once the money is already spent.
 *
 * The seam (../governor.ts) supplies the I/O — reading spend, writing the
 * ledger — and defers every JUDGEMENT to this file.
 */

import { createHash } from "node:crypto";
import { ukDayStartMs } from "@/lib/schedule/window";
import { formatDayKeyUK } from "@/lib/time/format";

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

/**
 * The HARD monthly AI ceiling, per org, in integer pence. £100.
 *
 * A CODE CONSTANT, not an environment variable, and that is a deliberate refusal
 * of the more flexible option. The number is PRODUCT POLICY: CrewFlow charges
 * ~£500/month/org, so £100 of inference is the point at which a fifth of the
 * subscription has been spent on a cost the customer never sees. Moving it
 * changes the unit economics of the whole business, which is a decision that
 * belongs in a reviewed diff with this comment attached — not in a deploy
 * dashboard where it can be raised at 2am to make an alert stop.
 *
 * It is also a SAFETY LIMIT rather than a target. Nothing should approach it in
 * normal operation; reaching it means something is wrong — a loop, a retry
 * storm, a prompt that grew — and the correct response is to stop, not to
 * budget up to it.
 */
export const AI_MONTHLY_CEILING_PENCE = 10_000;

/** Fraction of the ceiling at which the first warning fires. */
export const BUDGET_WARN_50_FRACTION = 0.5;
/** Fraction of the ceiling at which the urgent warning fires. */
export const BUDGET_WARN_80_FRACTION = 0.8;

/**
 * What the governor will let happen next, given spend so far this month.
 *
 * The two warn states are ADVISORY — they change nothing about whether a call
 * runs; they exist so HQ and the org see the wall coming. `blocked` is the only
 * state that refuses work.
 */
export type BudgetStatus = "allowed" | "warn_50" | "warn_80" | "blocked";

/**
 * Evaluate spend against the ceiling.
 *
 * Boundaries are INCLUSIVE at the lower edge of each band: exactly 50% warns,
 * exactly 80% warns harder, and exactly 100% blocks. Reaching the ceiling
 * precisely must block — a `>` here would let one final unbounded call through
 * at the worst possible moment, and "the ceiling was only exceeded by the call
 * that noticed it" is not a control.
 *
 * A non-positive ceiling means "no AI spend permitted at all", not "unlimited" —
 * the failure-safe reading. Negative or non-finite spend is treated as zero
 * rather than trusted; the ledger cannot produce it, but a caller can.
 */
export function evaluateBudget(
  spentPence: number,
  ceilingPence: number = AI_MONTHLY_CEILING_PENCE,
): BudgetStatus {
  if (!Number.isFinite(ceilingPence) || ceilingPence <= 0) return "blocked";
  const spent = Number.isFinite(spentPence) && spentPence > 0 ? spentPence : 0;
  const fraction = spent / ceilingPence;
  if (fraction >= 1) return "blocked";
  if (fraction >= BUDGET_WARN_80_FRACTION) return "warn_80";
  if (fraction >= BUDGET_WARN_50_FRACTION) return "warn_50";
  return "allowed";
}

/** True when the status permits a provider call. Only `blocked` refuses. */
export function budgetPermits(status: BudgetStatus): boolean {
  return status !== "blocked";
}

/** Spend as a percentage of the ceiling, rounded to a whole number, for display. */
export function budgetPercent(
  spentPence: number,
  ceilingPence: number = AI_MONTHLY_CEILING_PENCE,
): number {
  if (!Number.isFinite(ceilingPence) || ceilingPence <= 0) return 100;
  const spent = Number.isFinite(spentPence) && spentPence > 0 ? spentPence : 0;
  return Math.round((spent / ceilingPence) * 100);
}

// ---------------------------------------------------------------------------
// Spike detection
// ---------------------------------------------------------------------------

/** How far above the trailing average counts as a spike. */
export const SPIKE_MULTIPLIER = 3;

/**
 * Is this month's spend anomalous against the org's own trailing average?
 *
 * A spike is a RELATIVE signal, so it needs a baseline to be relative to. When
 * the trailing average is zero — a brand-new org, or the first month any AI ran
 * — there is no trend to deviate from, and `3 × 0 = 0` would flag every single
 * first month as a spike. A flag that fires for everyone is noise, and noise is
 * how a real spike gets ignored. So: no baseline, no spike. The ceiling is what
 * protects a first month; this rule protects against a QUIET, WITHIN-BUDGET
 * change in behaviour that nobody would otherwise notice.
 */
export function detectSpike(currentPence: number, trailingAveragePence: number): boolean {
  if (!Number.isFinite(currentPence) || !Number.isFinite(trailingAveragePence)) return false;
  if (trailingAveragePence <= 0) return false;
  return currentPence > SPIKE_MULTIPLIER * trailingAveragePence;
}

/** Mean of a series of monthly totals, ignoring non-finite entries. Empty ⇒ 0. */
export function trailingAverage(monthlyTotalsPence: ReadonlyArray<number>): number {
  const usable = monthlyTotalsPence.filter((n) => Number.isFinite(n));
  if (usable.length === 0) return 0;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

// ---------------------------------------------------------------------------
// The budget month — Europe/London, matching the SQL rollup
// ---------------------------------------------------------------------------

/** A budget month, as `YYYY-MM`. */
export type MonthKey = string;

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/**
 * The Europe/London calendar month an instant falls in, as `YYYY-MM`.
 *
 * UK, not UTC — the same rule the SQL rollup applies, and for the same reason:
 * a £100 MONTHLY ceiling is a calendar-month promise made to a UK operator. In
 * BST the two disagree for the first hour of each month, so an invocation at
 * 00:30 on 1 August (UK) has a UTC timestamp still reading 31 July. Bucketing
 * it into July would spend August's money out of July's budget — and, at the
 * boundary of a blocked month, would let the first call of a fresh month be
 * refused. Derived from `formatDayKeyUK`, the codebase's day-bucket idiom.
 */
export function ukMonthKeyOf(instant: Date | string | number): MonthKey {
  return formatDayKeyUK(instant).slice(0, 7);
}

/**
 * The half-open UTC instant range `[start, end)` covered by a UK budget month.
 *
 * Built from `ukDayStartMs`, the established inverse of the day-bucket idiom, so
 * the BST/GMT transitions inside a month are handled by the IANA database rather
 * than by arithmetic here. March and October are ordinary months to this
 * function; they are simply 23 or 25 hours shorter or longer than naive maths
 * would predict, which is exactly the error this avoids.
 *
 * Returns NaN bounds for a malformed key; callers treat that as "no usable
 * month" rather than silently querying an arbitrary window.
 */
export function ukMonthWindow(month: MonthKey): { startMs: number; endMs: number } {
  const m = MONTH_KEY.exec(month.trim());
  if (!m) return { startMs: Number.NaN, endMs: Number.NaN };
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return { startMs: Number.NaN, endMs: Number.NaN };
  const next = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    startMs: ukDayStartMs(`${month}-01`),
    endMs: ukDayStartMs(next.toISOString().slice(0, 10)),
  };
}

/** Shift a `YYYY-MM` key by whole calendar months. Pure label arithmetic. */
export function addMonths(month: MonthKey, delta: number): MonthKey {
  const m = MONTH_KEY.exec(month.trim());
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** The `count` months immediately BEFORE `month`, oldest first. The spike baseline. */
export function trailingMonths(month: MonthKey, count: number): ReadonlyArray<MonthKey> {
  if (!MONTH_KEY.test(month.trim()) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => addMonths(month, i - count));
}

/** How many months of history the spike baseline averages over. */
export const SPIKE_BASELINE_MONTHS = 3;

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/**
 * How recently an identical request counts as a duplicate. Fifteen minutes is
 * long enough to absorb a double-submit, an impatient retry, or a webhook
 * redelivery, and short enough that genuinely re-asking a question later — when
 * the underlying data may have changed — is never mistaken for waste.
 */
export const DEDUPE_WINDOW_MS = 15 * 60_000;

/**
 * The fingerprint of one request: SHA-256 hex of feature, task class and
 * content, domain-separated by a character that cannot occur in the first two.
 *
 * Domain separation is not pedantry. Concatenating naively lets
 * ("ab", "c") and ("a", "bc") hash identically, which across features means one
 * capability's cached-out result suppressing another's genuinely new call. The
 * content itself is NEVER stored — only this digest reaches the ledger, so a
 * receipt's contents or a customer's message cannot be reconstructed from the
 * cost telemetry.
 */
export function invocationHash(feature: string, taskClass: string, content: string): string {
  return createHash("sha256")
    .update(`${feature} ${taskClass} ${content}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** USD → GBP. A fixed, deliberately conservative rate; see `estimateCostPence`. */
export const USD_TO_GBP = 0.8;

/**
 * Estimate one invocation's cost in INTEGER PENCE.
 *
 * Two rounding decisions, both chosen to fail in the safe direction:
 *
 *   1. A non-zero cost NEVER rounds to 0. Sub-penny calls are the common case
 *      for cheap models, and flooring them would let a million classifications
 *      aggregate to £0 while real money left the account — the ceiling would
 *      then never trip. `Math.ceil` on a positive value costs at most a penny
 *      per call of over-reporting and cannot under-report.
 *   2. The USD→GBP rate is FIXED, not fetched. A budget control that depends on
 *      a live FX call has a network dependency in its refusal path; a fixed,
 *      slightly pessimistic rate keeps the ceiling enforceable offline. It
 *      over-estimates when sterling is strong, which is the direction that
 *      blocks too early rather than too late.
 *
 * Returns 0 for an unknown or unbound model — cost is OBSERVABILITY, never a
 * correctness gate, so an unpriced call still runs and is still recorded; only
 * its cost is unknown. This mirrors `textCostUsd` in lib/ai/text/cost.ts.
 */
export function estimateCostPence(
  binding: { usdPerMTokIn: number; usdPerMTokOut: number } | null,
  usage: { inputTokens: number; outputTokens: number },
): number {
  if (!binding) return 0;
  const inTok = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
  const outTok = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
  const usd =
    (inTok / 1_000_000) * binding.usdPerMTokIn + (outTok / 1_000_000) * binding.usdPerMTokOut;
  const pence = usd * USD_TO_GBP * 100;
  if (!Number.isFinite(pence) || pence <= 0) return 0;
  return Math.max(1, Math.ceil(pence));
}

/** Integer pence rendered as `£1.23`. Display only. */
export function formatPence(pence: number): string {
  const safe = Number.isFinite(pence) ? pence : 0;
  return `£${(safe / 100).toFixed(2)}`;
}
