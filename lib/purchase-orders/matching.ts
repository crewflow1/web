import { round2, sumMoney, toPounds } from "@/lib/money";
import { computeTotals } from "@/lib/quotes/totals";
import {
  computeReceiving,
  type PoReceiptStatus,
  type ReceivedQty,
} from "./receiving";

/**
 * THREE-WAY MATCH — ordered vs received vs billed, for one purchase order.
 * PURE: no DB, no I/O, no clock, no server-only imports.
 *
 * CrewFlow has had all three legs for a while and never compared them:
 *
 *   ORDERED   purchase_orders + purchase_order_line_items   (committed spend)
 *   RECEIVED  posted goods_received_notes + lines           (20261059/60)
 *   BILLED    `finances` rows carrying purchase_order_id    (20261009)
 *
 * Each leg has its own roll-up already — computeCommittedCosts, computeReceiving,
 * computePoBilling — and each answers its own question honestly. What nobody was
 * ever told is where the three DISAGREE, which is the single most common way a UK
 * contractor loses money on materials:
 *
 *   · the supplier bills MORE than was ordered            → over_billed
 *   · the supplier bills for goods that never arrived     → billed_not_received
 *   · goods arrive and are never billed                   → received_not_billed
 *     (a GRNI accrual: the cost is real, it is just missing from `finances`, so
 *      the job reads more profitable than it is until the invoice turns up)
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  NO TOLERANCE POLICY. Whether a £2 variance is worth a phone call is a   ║
 * ║  CEO decision, and it is NOT taken here. Every variance is flagged with  ║
 * ║  its exact size — down to the penny — and a human judges it. `MatchPolicy║
 * ║  .minMoneyVariance` defaults to 0 precisely so that nothing is hidden;   ║
 * ║  when the business decides on a threshold it is set in ONE place and no  ║
 * ║  caller changes shape. The same applies to AGE: "an accrual is only      ║
 * ║  worth chasing after N days" is the same class of decision, so this      ║
 * ║  module computes no ages and picks no cutoff — it exposes                ║
 * ║  `earliestPostedReceiptDate` so a human (or a later policy) can judge.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * READ-ONLY BY CONSTRUCTION. Detecting a variance posts nothing, corrects
 * nothing and adjusts nothing. A three-way match that "fixed" a discrepancy by
 * writing to `finances` would be the double-count the receiving milestone was
 * built to avoid — the actual cost lands exactly once, when recordSupplierBill
 * posts the supplier's invoice. There is no reference to `finances` writes
 * anywhere in this module, in its service, or in its page, and
 * __tests__/security/three-way-bill-matching.test.ts holds that.
 *
 * FOUR DELIBERATE DESIGN DECISIONS
 *
 * 1. ONE ROUNDING AUTHORITY FOR TWO LEGS. Both `ordered` and `received` are
 *    valued by `computeTotals` (lib/quotes/totals.ts) — the same function that
 *    computed the PO's stored subtotal/vat_total/total when it was raised. So
 *    the ordered leg equals the stored header total BY CONSTRUCTION, and the
 *    received leg is valued by the identical per-line-VAT algorithm. If the two
 *    legs were rounded by different code a multi-line order could show a
 *    penny of "variance" that is really a rounding fork, and the queue would
 *    cry wolf. All arithmetic is `lib/money` (round2/sumMoney) — never raw float
 *    sums — because both sides are numeric(12,2) in Postgres.
 *
 * 2. THE RECEIVED LEG IS VALUED AT THE ORDERED PRICE. There is no other price
 *    for goods that have arrived but not been invoiced, and it is the right one:
 *    it is the price the supplier agreed to, so any difference the invoice later
 *    shows is attributable to the SUPPLIER rather than to our own valuation.
 *
 * 3. POSTED-ONLY IS ENFORCED HERE, NOT IN THE CALLER. Warehouse M1 gives a GRN
 *    three states and voiding is the only correction path, so a VOIDED receipt
 *    must never count as received — that is the difference between "we have the
 *    goods" and "we thought we did". Callers hand in EVERY note with its status
 *    and this module filters, which is the one arrangement where no caller can
 *    get it wrong. `voidedGrnCount` / `draftGrnCount` are exposed so a surface
 *    can say what it excluded rather than silently disagreeing with the PO page.
 *
 * 4. QUANTITY VARIANCE IS ORDERED-VS-RECEIVED ONLY. A supplier bill in CrewFlow
 *    is a `finances` row: one net amount, no lines, no quantities. So there is
 *    no billed quantity to compare and this module never pretends otherwise —
 *    money is the only axis on which all THREE legs can meet, and quantity is
 *    reported per line where the data genuinely supports it.
 *
 * CIS IS NOT A BILLING VARIANCE. A CIS deduction withholds tax from what is PAID
 * to a subcontractor; it does not reduce what was invoiced. Migration 20261051
 * keeps that split deliberate — the deduction lives in `cis_bill_details`, a
 * separate 1:1 table, precisely so it can never move `finances.amount`. So the
 * billed leg here is the invoiced cost, CIS or not, and a 20% deduction does not
 * appear as an under-billing. Payment-side shortfalls belong to the CIS domain.
 */

/** A purchase-order line, as stored. */
export type MatchOrderedLine = {
  id: string;
  description: string;
  unit?: string | null;
  /** purchase_order_line_items.qty — numeric(12,2). */
  qty: number | string | null;
  unit_price: number | string | null;
  vat_rate: number | string | null;
  sort_order?: number | null;
};

/** A goods_received_lines row. */
export type MatchGrnLine = {
  purchase_order_line_item_id: string;
  qty_received: number | string | null;
};

/**
 * A goods received note WITH ITS STATUS. Hand in every note on the order —
 * draft, posted and void — and let this module decide what counts (decision 3).
 */
export type MatchGrn = {
  id: string;
  number: string;
  /** 'draft' | 'posted' | 'void'. */
  status: string;
  delivery_date?: string | null;
  lines: MatchGrnLine[];
};

/**
 * A supplier bill — a `public.finances` row. `amount` is NET (ex-VAT) and
 * `vat_total` is the STORED GENERATED column, so gross = amount + vat_total.
 */
export type MatchBill = {
  id: string;
  /** finances.purchase_order_id. null = this bill matches no order at all. */
  purchase_order_id?: string | null;
  amount: number | string | null;
  vat_total: number | string | null;
  reference?: string | null;
  bill_date?: string | null;
};

/**
 * The knob a tolerance would turn — present so introducing one later needs no
 * change at any call site. See the NO TOLERANCE POLICY box above.
 */
export type MatchPolicy = {
  /**
   * Money variance (£, gross) that must be EXCEEDED before a variance is
   * flagged. DEFAULT 0: every penny is reported.
   */
  minMoneyVariance: number;
};

/** The default, and the only policy any caller passes today: flag everything. */
export const NO_TOLERANCE_POLICY: MatchPolicy = { minMoneyVariance: 0 };

/**
 * Half a penny. This is a FLOAT-NOISE guard, NOT a business tolerance: both
 * sides are numeric(12,2), so the smallest variance that can exist in the
 * database is £0.01 — twice this — and no real variance can hide behind it.
 * Same constant, same reason, as computePoBilling and computeReceiving.
 */
const EPSILON = 0.005;

export type ThreeWayMatchState =
  /** Nothing received and nothing billed — an open order, not a discrepancy. */
  | "open"
  /** All three legs agree. */
  | "matched"
  /** Billing is behind the order and consistent with what has arrived. */
  | "part_billed"
  /** Goods on site with no bill against them — a GRNI accrual. */
  | "received_not_billed"
  /** The supplier has invoiced more than has physically arrived. */
  | "billed_not_received"
  /** The supplier has invoiced more than was ORDERED. */
  | "over_billed";

/** The three states that are exceptions a human must look at. */
export type MatchFindingKind = "over_billed" | "billed_not_received" | "received_not_billed";

/**
 * Worst first. `over_billed` outranks the rest because it is money the company
 * never agreed to spend; `billed_not_received` next because it is a demand to
 * pay for goods nobody has seen; the accrual last because the money has not
 * left — the cost is simply understated until the invoice arrives.
 */
export const MATCH_STATE_RANK: Record<ThreeWayMatchState, number> = {
  over_billed: 5,
  billed_not_received: 4,
  received_not_billed: 3,
  part_billed: 2,
  matched: 1,
  open: 0,
};

/** One variance, with its exact size. Never a band, never a rounded "about". */
export type MatchFinding = {
  kind: MatchFindingKind;
  /** Size of the variance, GROSS (£) — always positive. */
  gross: number;
  /** The same variance NET of VAT — the figure that is missing from job cost. */
  net: number;
  /**
   * Quantity variance in ordered units, where line data supports it. Null on
   * `over_billed`, which is a money-only comparison (a bill has no lines).
   */
  qty: number | null;
};

/** A money leg: net, VAT and gross, all 2dp. */
export type MatchLeg = { net: number; vat: number; gross: number };

/** Per-line ordered-vs-received, in both quantity and money. */
export type MatchLine = {
  lineId: string;
  description: string;
  unit: string;
  unitPrice: number;
  vatRate: number;
  orderedQty: number;
  receivedQty: number;
  /** orderedQty − receivedQty. Positive = still outstanding, negative = over-received. */
  qtyVariance: number;
  ordered: MatchLeg;
  received: MatchLeg;
  /** More arrived than was ordered — the database refuses this, so it is old or seeded data. */
  overReceived: boolean;
};

export type ThreeWayMatch = {
  /** Line-derived value of the order as raised. Equals the stored PO total. */
  ordered: MatchLeg;
  /**
   * What the order COMMITS, gross. Equals `ordered.gross`, except on a
   * CANCELLED order where it is 0 — a cancelled order commits nothing, which is
   * the definition computeCommittedCosts already uses for the job's committed
   * position. So a bill against a cancelled order is over-billed by its whole
   * value, which is exactly what it is.
   */
  committedGross: number;
  /** Posted receipts, valued at the ordered price (decision 2). */
  received: MatchLeg;
  /** Bills linked to THIS order. */
  billed: MatchLeg;
  lines: MatchLine[];
  /** billed.gross − committedGross. Positive = over-billed. */
  billedVsOrdered: number;
  /** billed.gross − received.gross. Positive = billed ahead of the goods. */
  billedVsReceived: number;
  /** received.gross − billed.gross. Positive = an accrual. Mirror of the above. */
  accrual: number;
  state: ThreeWayMatchState;
  /** Every variance found, worst first. Empty for open/matched/part_billed. */
  findings: MatchFinding[];
  /** The largest flagged variance, gross (0 when there are none) — the sort key. */
  worstVariance: number;
  /**
   * The money the supplier is asking for that this order does not justify, gross
   * — and the ONLY figure that may be summed across orders.
   *
   *   billed − min(committed, received)
   *
   * `over_billed` and `billed_not_received` are frequently the SAME pounds seen
   * from two angles: invoice an order £120 over when it is fully delivered and
   * both findings read £120, but the company has been asked for £120 too much,
   * not £240. Adding the two per-kind totals therefore overstates the exposure,
   * so any roll-up (the Daily Briefing line) must add THIS instead. Zero when
   * neither money-out variance is flagged; the accrual is deliberately excluded
   * — nothing has been overpaid there.
   */
  moneyOutAtRisk: number;
  /** True when `state` is one of the three exception states. */
  isDiscrepancy: boolean;
  /** Receipt position, identical to computeReceiving / po_receipt_state(). */
  receiptStatus: PoReceiptStatus;
  postedGrnCount: number;
  voidedGrnCount: number;
  draftGrnCount: number;
  billCount: number;
  /**
   * Bills handed in with NO purchase_order_id — EXCLUDED from `billed`. A bill
   * that references no order cannot be three-way matched against one, and
   * quietly crediting it here would make an unmatched cost look reconciled.
   */
  unlinkedBillCount: number;
  /** Bills handed in that belong to a DIFFERENT order — also excluded. */
  foreignBillCount: number;
  /** A line where more arrived than was ordered. */
  hasOverReceipt: boolean;
  /**
   * Earliest delivery_date across POSTED notes, or null. Exposed instead of an
   * age so no cutoff is chosen here (see the NO TOLERANCE POLICY box).
   */
  earliestPostedReceiptDate: string | null;
};

function qty(v: number | string | null | undefined): number {
  return round2(toPounds(v));
}

/** Value a set of (qty, price, vat) triples with the PO's own rounding authority. */
function valueLines(
  rows: ReadonlyArray<{ description: string; unit: string; qty: number; unit_price: number; vat_rate: number }>,
): { leg: MatchLeg; perLine: Array<{ net: number; vat: number; gross: number }> } {
  const totals = computeTotals([...rows]);
  const perLine = totals.lines.map((l) => ({
    net: l.line_total,
    vat: l.line_vat,
    gross: round2(l.line_total + l.line_vat),
  }));
  return {
    leg: { net: totals.subtotal, vat: totals.vat_total, gross: totals.total },
    perLine,
  };
}

/**
 * Match one purchase order's three legs.
 *
 * @param input.lines     the order's line items (ordered qty + price + VAT rate)
 * @param input.grns      EVERY goods received note on the order, with its status
 * @param input.bills     `finances` rows; ones not linked to `poId` are excluded
 * @param input.poId      the order being matched — the bill-link filter's authority
 * @param input.cancelled the order's status is 'cancelled'
 */
export function matchThreeWay(
  input: {
    poId: string;
    lines: readonly MatchOrderedLine[];
    grns: readonly MatchGrn[];
    bills: readonly MatchBill[];
    cancelled?: boolean;
  },
  policy: MatchPolicy = NO_TOLERANCE_POLICY,
): ThreeWayMatch {
  // ── receipts: POSTED ONLY (decision 3) ────────────────────────────────────
  const posted = input.grns.filter((g) => g.status === "posted");
  const receipts: ReceivedQty[] = posted.flatMap((g) =>
    (g.lines ?? []).map((l) => ({
      purchase_order_line_item_id: l.purchase_order_line_item_id,
      qty_received: l.qty_received,
    })),
  );

  // Quantity position comes from the SAME function the PO page uses, so the
  // queue and the order page can never tell the user two different stories
  // about what has arrived. It already sums across multiple GRNs per line.
  const receiving = computeReceiving({ lines: [...input.lines], receipts });
  const receivedByLine = new Map(receiving.lines.map((l) => [l.lineId, l.previouslyReceived]));

  const orderedRows = input.lines.map((li) => ({
    description: li.description,
    unit: li.unit?.trim() || "ea",
    qty: qty(li.qty),
    unit_price: qty(li.unit_price),
    vat_rate: qty(li.vat_rate),
  }));
  const receivedRows = input.lines.map((li, i) => ({
    ...orderedRows[i]!,
    qty: receivedByLine.get(li.id) ?? 0,
  }));

  const orderedValued = valueLines(orderedRows);
  const receivedValued = valueLines(receivedRows);

  const lines: MatchLine[] = input.lines.map((li, i) => {
    const orderedQty = orderedRows[i]!.qty;
    const receivedQty = receivedRows[i]!.qty;
    return {
      lineId: li.id,
      description: li.description,
      unit: orderedRows[i]!.unit,
      unitPrice: orderedRows[i]!.unit_price,
      vatRate: orderedRows[i]!.vat_rate,
      orderedQty,
      receivedQty,
      qtyVariance: round2(orderedQty - receivedQty),
      ordered: orderedValued.perLine[i] ?? { net: 0, vat: 0, gross: 0 },
      received: receivedValued.perLine[i] ?? { net: 0, vat: 0, gross: 0 },
      overReceived: receivedQty > orderedQty + EPSILON,
    };
  });

  // ── bills: only the ones that actually reference THIS order ───────────────
  const linked: MatchBill[] = [];
  let unlinkedBillCount = 0;
  let foreignBillCount = 0;
  for (const b of input.bills) {
    const link = b.purchase_order_id ?? null;
    if (link === null) unlinkedBillCount++;
    else if (link !== input.poId) foreignBillCount++;
    else linked.push(b);
  }
  const billedNet = sumMoney(linked.map((b) => b.amount));
  const billedVat = sumMoney(linked.map((b) => b.vat_total));
  const billed: MatchLeg = { net: billedNet, vat: billedVat, gross: round2(billedNet + billedVat) };

  const ordered = orderedValued.leg;
  const received = receivedValued.leg;
  const cancelled = input.cancelled === true;
  const committedGross = cancelled ? 0 : ordered.gross;
  const committedNet = cancelled ? 0 : ordered.net;

  const billedVsOrdered = round2(billed.gross - committedGross);
  const billedVsReceived = round2(billed.gross - received.gross);
  const accrual = round2(received.gross - billed.gross);

  // A variance is flagged when it EXCEEDS the greater of the float-noise floor
  // and the (currently zero) policy threshold. With the default policy that
  // means anything from £0.01 upwards.
  const floor = Math.max(EPSILON, policy.minMoneyVariance);
  const material = (v: number): boolean => v > floor;

  const findings: MatchFinding[] = [];
  if (material(billedVsOrdered)) {
    findings.push({
      kind: "over_billed",
      gross: billedVsOrdered,
      net: round2(billed.net - committedNet),
      // A bill carries no lines, so there is no quantity to compare (decision 4).
      qty: null,
    });
  }
  if (material(billedVsReceived)) {
    findings.push({
      kind: "billed_not_received",
      gross: billedVsReceived,
      net: round2(billed.net - received.net),
      // The quantity still outstanding on the order is what has NOT arrived.
      qty: receiving.totalRemaining,
    });
  }
  if (material(accrual)) {
    findings.push({
      kind: "received_not_billed",
      gross: accrual,
      net: round2(received.net - billed.net),
      qty: receiving.totalPreviouslyReceived,
    });
  }
  findings.sort((a, b) => MATCH_STATE_RANK[b.kind] - MATCH_STATE_RANK[a.kind]);

  let state: ThreeWayMatchState;
  if (findings.length > 0) {
    state = findings[0]!.kind;
  } else if (posted.length === 0 && linked.length === 0) {
    // "Open" is a statement about EVENTS, not about money: nothing has been
    // delivered and nothing has been invoiced. Testing the money instead would
    // file a £0 order (free issue, a sundries line at nil) as "open" for ever
    // even after the lorry had been and gone.
    state = "open";
  } else if (Math.abs(billedVsOrdered) <= floor) {
    // No findings means billed agrees with received; agreeing with the
    // commitment too makes all three legs one number.
    state = "matched";
  } else {
    state = "part_billed";
  }

  const postedDates = posted
    .map((g) => g.delivery_date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();

  return {
    ordered,
    committedGross,
    received,
    billed,
    lines,
    billedVsOrdered,
    billedVsReceived,
    accrual,
    state,
    findings,
    worstVariance: findings.reduce((m, f) => Math.max(m, f.gross), 0),
    // The two money-out kinds are often the same pounds twice over, so the
    // summable exposure is the LARGER of them, never the sum.
    moneyOutAtRisk: findings.reduce(
      (m, f) => (f.kind === "received_not_billed" ? m : Math.max(m, f.gross)),
      0,
    ),
    isDiscrepancy: findings.length > 0,
    receiptStatus: receiving.status,
    postedGrnCount: posted.length,
    voidedGrnCount: input.grns.filter((g) => g.status === "void").length,
    draftGrnCount: input.grns.filter((g) => g.status === "draft").length,
    billCount: linked.length,
    unlinkedBillCount,
    foreignBillCount,
    hasOverReceipt: lines.some((l) => l.overReceived),
    earliestPostedReceiptDate: postedDates[0] ?? null,
  };
}

export const MATCH_STATE_LABEL: Record<ThreeWayMatchState, string> = {
  open: "Open order",
  matched: "Matched",
  part_billed: "Part-billed",
  received_not_billed: "Received, not billed",
  billed_not_received: "Billed, not received",
  over_billed: "Over-billed",
};

/** Tailwind accent for the state pill — matches the house palette on the PO page. */
export const MATCH_STATE_CLASS: Record<ThreeWayMatchState, string> = {
  open: "bg-slate-100 text-slate-700",
  matched: "bg-emerald-100 text-emerald-800",
  part_billed: "bg-slate-100 text-slate-700",
  received_not_billed: "bg-amber-100 text-amber-800",
  billed_not_received: "bg-orange-100 text-orange-900",
  over_billed: "bg-red-100 text-red-800",
};

/**
 * One plain-English sentence per finding, with the number in it. No hedging and
 * no advice about what is "acceptable" — the size is stated, the human decides.
 */
export function describeFinding(f: MatchFinding, formatMoney: (n: number) => string): string {
  switch (f.kind) {
    case "over_billed":
      return `The supplier has invoiced ${formatMoney(f.gross)} more than this order commits.`;
    case "billed_not_received":
      return `${formatMoney(f.gross)} has been invoiced for goods that have not been recorded as delivered.`;
    case "received_not_billed":
      return `${formatMoney(f.gross)} of goods has been delivered with no supplier bill against it — the cost is missing from this job.`;
  }
}

/**
 * Worst-first ordering for a queue of matched orders.
 *
 * Total by construction: state rank, then variance, then the order number,
 * which is unique per org (purchase_orders_org_number_key). A paged read can
 * therefore never drop or repeat a row at a page edge.
 */
export function compareMatchSeverity(
  a: { match: ThreeWayMatch; number: string },
  b: { match: ThreeWayMatch; number: string },
): number {
  return (
    MATCH_STATE_RANK[b.match.state] - MATCH_STATE_RANK[a.match.state] ||
    b.match.worstVariance - a.match.worstVariance ||
    a.number.localeCompare(b.number)
  );
}
