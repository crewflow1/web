import { round2 } from "@/lib/money";
import { addDays, daysBetween } from "@/lib/schedule/window";
import { labelled, type LabelledMetric, type EvidenceRef } from "./provenance";

/**
 * FORWARD CASH TIMELINE — a week-by-week projection of cash MOVEMENT. PURE.
 *
 * ── WHAT THIS IS, AND WHAT IT REFUSES TO BE ─────────────────────────────────
 * The existing cash surfaces (lib/commercial/cash-out, org-cash, cash-forecast)
 * answer "what's owed / owing RIGHT NOW" and bucket receivables into
 * next7/next30/later. This module answers a different, forward question: laid
 * out over the next N weeks, WHEN does money land and leave, and where is the
 * tightest point? It composes those authorities — it does not re-derive a
 * single figure of its own beyond placing already-computed amounts on their
 * already-known dates and summing per week.
 *
 * It is NOT a bank-balance forecast. CrewFlow holds no authoritative current
 * cash balance (bank_statements are reconciliation input, not a running
 * balance), so inventing an opening balance would be a fabricated number — the
 * one thing the honesty doctrine forbids. `cumulativeNet` is therefore the
 * projected CHANGE in cash from today (baseline £0), stated as such. The
 * `shortfall` flag means the running change dips below zero — i.e. more leaves
 * than arrives within the horizon and today's balance would have to cover the
 * gap — never "you will be overdrawn", which would require a balance this
 * product does not know.
 *
 * ── CERTAINTY TRAVELS WITH EVERY POUND ──────────────────────────────────────
 * Each event carries a `certainty` (the cash-out.ts ladder, transposed):
 *   invoiced   a raised invoice past/at a due date — a ledger fact.
 *   scheduled  a contractual retention release date — a contract term.
 *   estimated  a VAT / CIS liability on a statutory deadline — an estimate on a
 *              mixed accounting basis (the tax module's own caveat).
 *   planned    a recurring expense-budget target spread evenly — a PLAN the
 *              operator set, never an incurred cost.
 * The timeline never collapses these into one "expected cash" number without
 * their labels; the UI shows the mix, and the metric is HEURISTIC because
 * placing estimated/planned money on a date is a judgement, stated verbatim.
 *
 * ── HONESTY: absent data is `insufficient`, never a flat £0 line ─────────────
 * With no dated events at all, `sufficient` is false and the caller says "not
 * enough dated cash events to project" — a zero line drawn across the weeks
 * would read as "nothing is coming or going", a claim, and a wrong one.
 * Undated money (a bill with no due date, an unattributable release) is carried
 * in `undated`, never silently dropped and never guessed onto a week.
 *
 * PURE: no I/O, no clock. `todayKey` is the injected London day; every week
 * boundary is pure key arithmetic (lib/schedule/window.addDays), so the same
 * inputs always yield the same timeline.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type CashDirection = "in" | "out";

export const CASH_CERTAINTIES = ["invoiced", "scheduled", "estimated", "planned"] as const;
export type CashCertainty = (typeof CASH_CERTAINTIES)[number];

/** One dated (or undated) expected cash movement. */
export type CashEvent = {
  /** London day the cash is expected (YYYY-MM-DD); null = no date known. */
  dateKey: string | null;
  direction: CashDirection;
  /** Positive magnitude in £ (direction carries the sign). */
  amount: number;
  /** Reader-facing group ("Invoice due", "Retention release", "VAT", "CIS", "Recurring costs"). */
  category: string;
  certainty: CashCertainty;
  label: string | null;
  href: string | null;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type CashWeek = {
  index: number;
  /** Inclusive London day the week starts. */
  startDay: string;
  /** Inclusive London day the week ends (startDay + 6). */
  endDay: string;
  inflow: number;
  outflow: number;
  /** inflow − outflow for the week. */
  net: number;
  /** Running Σ net from week 0 through this week (change from today, not a balance). */
  cumulativeNet: number;
  items: CashEvent[];
};

export type CashTimeline = {
  /** false → no dated events to project; the surface must say so, not draw £0. */
  sufficient: boolean;
  todayKey: string;
  horizonWeeks: number;
  weeks: CashWeek[];
  /** Σ dated inflow within the horizon (incl. overdue folded into week 0). */
  totalInflow: number;
  /** Σ dated outflow within the horizon. */
  totalOutflow: number;
  /** totalInflow − totalOutflow — the net change across the whole horizon. */
  netMovement: number;
  /** The lowest running cumulativeNet reached (the tightest point). */
  lowestCumulative: number;
  /** Index of the week where lowestCumulative occurs, or null when no weeks. */
  lowestWeekIndex: number | null;
  /** true when the running change dips below zero somewhere in the horizon. */
  shortfall: boolean;
  /** Money whose date is before today, folded into week 0 (already owed/late). */
  overdueInflow: number;
  overdueOutflow: number;
  /** Dated later than the horizon — disclosed, not projected. */
  beyondHorizon: { inflow: number; outflow: number; count: number };
  /** No date known — carried, never guessed onto a week. */
  undated: { inflow: number; outflow: number; items: CashEvent[] };
};

const MAX_HORIZON_WEEKS = 52;

function emptyWeek(index: number, startDay: string): CashWeek {
  return {
    index,
    startDay,
    endDay: addDays(startDay, 6),
    inflow: 0,
    outflow: 0,
    net: 0,
    cumulativeNet: 0,
    items: [],
  };
}

/**
 * Deterministic ordering inside a week: outflows before inflows (a conservative
 * reader wants to see money leave first), then by amount desc, then category,
 * then label — a total order so two loads never reshuffle.
 */
function orderEvents(a: CashEvent, b: CashEvent): number {
  if (a.direction !== b.direction) return a.direction === "out" ? -1 : 1;
  return (
    b.amount - a.amount ||
    a.category.localeCompare(b.category) ||
    (a.label ?? "").localeCompare(b.label ?? "")
  );
}

export function computeCashTimeline(input: {
  events: readonly CashEvent[];
  todayKey: string;
  horizonWeeks: number;
}): CashTimeline {
  const horizonWeeks = Math.min(MAX_HORIZON_WEEKS, Math.max(1, Math.trunc(input.horizonWeeks)));
  const todayKey = input.todayKey;

  const weeks: CashWeek[] = [];
  for (let i = 0; i < horizonWeeks; i++) {
    weeks.push(emptyWeek(i, addDays(todayKey, i * 7)));
  }
  const horizonEndDay = weeks[weeks.length - 1]!.endDay;

  let overdueInflow = 0;
  let overdueOutflow = 0;
  const beyondHorizon = { inflow: 0, outflow: 0, count: 0 };
  const undated = { inflow: 0, outflow: 0, items: [] as CashEvent[] };
  let datedCount = 0;

  for (const ev of input.events) {
    const amount = round2(Math.max(0, ev.amount));
    if (amount <= 0) continue;

    // Undated — carried, never guessed onto a week.
    if (!ev.dateKey) {
      if (ev.direction === "in") undated.inflow = round2(undated.inflow + amount);
      else undated.outflow = round2(undated.outflow + amount);
      undated.items.push(ev);
      continue;
    }

    datedCount += 1;

    // Beyond the horizon — disclosed, not projected onto a week.
    if (ev.dateKey > horizonEndDay) {
      if (ev.direction === "in") beyondHorizon.inflow = round2(beyondHorizon.inflow + amount);
      else beyondHorizon.outflow = round2(beyondHorizon.outflow + amount);
      beyondHorizon.count += 1;
      continue;
    }

    // Before today (overdue) → folded into week 0: the cash is expected imminently.
    let weekIndex: number;
    if (ev.dateKey < todayKey) {
      weekIndex = 0;
      if (ev.direction === "in") overdueInflow = round2(overdueInflow + amount);
      else overdueOutflow = round2(overdueOutflow + amount);
    } else {
      weekIndex = Math.floor(daysBetween(todayKey, ev.dateKey) / 7);
      if (weekIndex < 0) weekIndex = 0;
      if (weekIndex >= weeks.length) weekIndex = weeks.length - 1;
    }

    const week = weeks[weekIndex]!;
    week.items.push(ev);
    if (ev.direction === "in") week.inflow = round2(week.inflow + amount);
    else week.outflow = round2(week.outflow + amount);
  }

  // Per-week net + running cumulative + the tightest point.
  let cumulative = 0;
  let lowestCumulative = 0;
  let lowestWeekIndex: number | null = null;
  let totalInflow = 0;
  let totalOutflow = 0;
  for (const week of weeks) {
    week.items.sort(orderEvents);
    week.net = round2(week.inflow - week.outflow);
    cumulative = round2(cumulative + week.net);
    week.cumulativeNet = cumulative;
    totalInflow = round2(totalInflow + week.inflow);
    totalOutflow = round2(totalOutflow + week.outflow);
    if (lowestWeekIndex === null || cumulative < lowestCumulative) {
      lowestCumulative = cumulative;
      lowestWeekIndex = week.index;
    }
  }

  return {
    sufficient: datedCount > 0,
    todayKey,
    horizonWeeks,
    weeks,
    totalInflow,
    totalOutflow,
    netMovement: round2(totalInflow - totalOutflow),
    lowestCumulative,
    lowestWeekIndex,
    // Below zero AND a real dip (guard the all-empty case reporting a false shortfall).
    shortfall: datedCount > 0 && lowestCumulative < 0,
    overdueInflow,
    overdueOutflow,
    beyondHorizon,
    undated,
  };
}

// ---------------------------------------------------------------------------
// Labelled metric
// ---------------------------------------------------------------------------

const CASH_TIMELINE_EVIDENCE: EvidenceRef[] = [
  { label: "Cash", href: "/cash" },
  { label: "Invoices", href: "/invoices" },
  { label: "VAT & CIS", href: "/tax" },
];

/**
 * HEURISTIC: the amounts are ledger facts and statutory estimates, but placing
 * each on its due / scheduled / statutory date and spreading a recurring budget
 * evenly is a stated projection rule — so the whole timeline is a heuristic and
 * says which of its pounds are estimates and plans.
 */
export function cashTimelineMetric(t: CashTimeline): LabelledMetric<CashTimeline> {
  return labelled(t, {
    kind: "heuristic",
    basis:
      "Projects the CHANGE in your cash over the next " +
      `${t.horizonWeeks} weeks — not your bank balance, which CrewFlow doesn't hold. Raised ` +
      "invoices land on their due date (overdue ones in week 1); retention releases on their " +
      "contractual date; VAT and CIS on their statutory deadline (estimates on a mixed basis); " +
      "recurring expense budgets are spread evenly as a plan, not an incurred cost. Bills with no " +
      "due date and money dated beyond the horizon are shown separately, never forced onto a week. " +
      "The tightest point is the lowest running change; a shortfall means more leaves than arrives " +
      "within the horizon, which today's balance would need to cover.",
    computedFrom: CASH_TIMELINE_EVIDENCE,
  });
}
