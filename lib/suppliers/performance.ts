import { round2, sumMoney } from "@/lib/money";
import { addDaysIso } from "@/lib/time/compute";
import { computePoBilling } from "@/lib/purchase-orders/billing";
import { computeReceiving, type PoReceiptStatus } from "@/lib/purchase-orders/receiving";
import {
  computeBillSettlements,
  isLivePayment,
  type SupplierAllocationRow,
  type SupplierBillRow,
  type SupplierPaymentRow,
} from "@/lib/suppliers/payments";

/**
 * Supplier & subcontractor PERFORMANCE — MEASUREMENT, NOT PREDICTION.
 *
 * PURE: no Supabase, no `server-only`, no clock reads, no I/O. Every function
 * that needs "today" takes it as an argument (the lib/cis/verification.ts
 * discipline), so every figure here is reproducible from its inputs alone.
 *
 * ── WHAT THIS MODULE IS ALLOWED TO BE ──────────────────────────────────────
 * docs/roadmap/STATUS.md Phase 9 says subcontractor scoring and delay/labour/
 * material prediction are NOT BUILT and "must ship as DETERMINISTIC metrics
 * first, never labelled as prediction". That is the whole design brief, and it
 * has four consequences that are enforced here rather than left to reviewers:
 *
 *   1. EVERY METRIC IS A COUNT OR A RATIO OF OBSERVED FACTS. There is no score
 *      out of ten, no letter grade, no stars, no weights, no model, no AI. A
 *      weight is an opinion wearing a number's clothes: it decides that one
 *      late delivery is worth N over-billed orders, and nothing in this
 *      database knows that exchange rate.
 *
 *   2. NO COMPOSITE. There is deliberately no single "supplier score" export.
 *      The four groups below have DIFFERENT DENOMINATORS (deliveries, orders,
 *      bills) and measure DIFFERENT PARTIES (their punctuality vs OUR payment
 *      speed), so no honest arithmetic combines them. The comparison surface
 *      shows them side by side, each with its own sample size, and the buyer
 *      does the weighing — because the buyer is the one who knows whether this
 *      job is schedule-critical or margin-critical.
 *
 *   3. SAMPLE SIZE IS PART OF THE METRIC, NOT A FOOTNOTE. See `ratio()`.
 *      "100% late" from one delivery is not a performance record, it is one
 *      delivery. A rate whose denominator is too small is returned as `null`,
 *      so a caller CANNOT render a percentage it has not earned — the type
 *      system makes the small-sample case unignorable.
 *
 *   4. MONEY AND RECEIPT STATE ARE NEVER RE-DERIVED. Bill-vs-order variance
 *      composes `computePoBilling`; receipt completeness composes
 *      `computeReceiving` (itself pinned to `po_receipt_state()` in the
 *      database); bill settlement composes `computeBillSettlements`. This
 *      module adds NO settlement and NO CIS arithmetic of its own — it counts
 *      the verdicts those authorities return. `__tests__/security/
 *      supplier-performance-readonly.test.ts` pins that.
 *
 * ── WHAT IS DELIBERATELY MISSING: SNAG ATTRIBUTION ─────────────────────────
 * The brief asked for a quality signal from `snags` "where the data supports
 * attribution". IT DOES NOT, so there is none, and that absence is the honest
 * answer rather than a gap.
 *
 * `public.snags` (20260919000000) carries org_id, job_id, `trade` (FREE TEXT),
 * `assigned_to` → public.users and `reported_by` → public.users. There is no
 * supplier_id, no purchase_order_id, and no work-package entity anywhere in the
 * schema to hang one on (`work_packages` does not exist in any migration).
 * `assigned_to` is an INTERNAL org member — the person fixing the snag, who is
 * usually one of our own. The only available bridge would be matching a snag's
 * free-text `trade` against a supplier's free-text `category`, which would
 * (a) attribute a snag to every "Electrical" supplier at once, and (b) blame a
 * supplier for our own labour's defects. That is manufacturing a link, and a
 * manufactured quality metric on a supplier record is defamation with a
 * denominator. When a snag gains a real responsible-party FK, it belongs here.
 *
 * ── DATES ──────────────────────────────────────────────────────────────────
 * `delivery_date`, `expected_date` and `bill_date` are Postgres `date` columns:
 * plain calendar days with NO time and NO zone, so comparing them needs no
 * timezone logic and must not acquire any (constructing a London instant from a
 * bare date is how an off-by-one appears at the BST boundary). Ordering is
 * therefore LEXICOGRAPHIC on `yyyy-mm-dd`, which is exact, and every threshold
 * ("more than 3 days late") is built by shifting the OTHER date with the
 * existing `addDaysIso` from lib/time/compute. No date helper is added and no
 * millisecond arithmetic happens anywhere in this file.
 */

// ---------------------------------------------------------------------------
// Sample size — the guard that stops this feature libelling a supplier
// ---------------------------------------------------------------------------

/**
 * The minimum denominator at which a RATE is reported at all.
 *
 * THE CONVENTION: below 5 comparable observations a supplier gets COUNTS ONLY —
 * never a percentage. At n = 5 one event moves the rate by 20 percentage
 * points, and that is the most volatility a figure can carry while still being
 * worth printing; at n = 4 it is 25pp, at n = 2 it is 50pp, and at n = 1 the
 * "rate" is just the event restated as either 0% or 100%. A buyer who reads
 * "100% late" and walks away from a merchant who was once late on one delivery
 * has been actively misled by a true number, which is the specific harm this
 * threshold exists to prevent.
 *
 * It is a floor on REPORTING a rate, never a filter on the underlying records:
 * the counts and the sample size are always shown, so a small record reads as
 * "1 of 2 deliveries late — too few to rate" and the operator can click
 * through to both.
 */
export const MIN_RATED_SAMPLE = 5;

/**
 * A count against its denominator, with the rate withheld until the sample
 * earns it.
 *
 * `pct` is `null` — not 0, not NaN, not "—" — when `n < MIN_RATED_SAMPLE`, so
 * every render site has to handle the small-sample case explicitly instead of
 * formatting a number that should not exist. That is the point: making it a
 * nullable type moves the convention from a documented promise into something
 * the compiler asks about.
 */
export type Ratio = {
  /** Observations WITH the property being counted. */
  count: number;
  /** Comparable observations in total — THE SAMPLE SIZE. Always displayed. */
  n: number;
  /** count / n as a whole percentage, or null when the sample is too small. */
  pct: number | null;
  /** n >= MIN_RATED_SAMPLE. */
  rated: boolean;
};

export function ratio(count: number, n: number): Ratio {
  const rated = n >= MIN_RATED_SAMPLE;
  return {
    count,
    n,
    pct: rated && n > 0 ? Math.round((count / n) * 100) : null,
    rated,
  };
}

/** True when a ratio has a rate worth printing. Narrows `pct` for callers. */
export function isRated(r: Ratio): r is Ratio & { pct: number } {
  return r.pct !== null;
}

// ---------------------------------------------------------------------------
// Date guard (validation, not arithmetic — see the header note on dates)
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict `yyyy-mm-dd` validation, including rejecting impossible days by
 * round-tripping through UTC. Mirrors the private `parseIsoDate` in
 * lib/cis/verification.ts.
 *
 * This VALIDATES; it never computes. It exists because `addDaysIso` would throw
 * a RangeError on junk input, and because a date we cannot read must be
 * EXCLUDED from a punctuality denominator rather than guessed at — an
 * unparseable expected date is an order with no promise on it, not an on-time
 * delivery.
 */
function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Row shapes, exactly as the read layer selects them
// ---------------------------------------------------------------------------

/** A `public.goods_received_notes` row. */
export type PerfGrnRow = {
  id: string;
  purchase_order_id: string;
  /** 'draft' | 'posted' | 'void'. ONLY 'posted' is a delivery. */
  status: string;
  number?: string | null;
  delivery_date: string | null;
};

/** A `public.purchase_orders` row. */
export type PerfPoRow = {
  id: string;
  number?: string | null;
  /** 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled'. */
  status: string;
  /** The date the supplier was asked to deliver by. NULL = no promise made. */
  expected_date: string | null;
  /** Committed gross (subtotal + vat_total, generated). */
  total: number | string | null;
};

/** A `public.purchase_order_line_items` row. */
export type PerfPoLineRow = {
  id: string;
  purchase_order_id: string;
  description?: string | null;
  qty: number | string | null;
  unit?: string | null;
};

/** A `public.goods_received_lines` row (caller filters to POSTED notes). */
export type PerfGrnLineRow = {
  goods_received_note_id: string;
  purchase_order_line_item_id: string;
  qty_received: number | string | null;
};

/**
 * A supplier bill — the settlement authority's own row shape plus the PO link
 * that 20261009000000 added to `finances`. Extended here rather than widened in
 * lib/suppliers/payments.ts because the settlement ledger has no business
 * knowing about purchase orders; only this module compares the two.
 */
export type PerfBillRow = SupplierBillRow & {
  purchase_order_id?: string | null;
};

// ---------------------------------------------------------------------------
// Group A — delivery reliability
// ---------------------------------------------------------------------------

/**
 * How late a late delivery was, in bands rather than as an average.
 *
 * A mean would be neither a count nor a ratio, and it hides the shape that
 * matters: a supplier eight days late once is a different risk from one a day
 * late eight times, and both average badly. Bands are counts, so they stay
 * inside the brief AND carry the severity a buyer actually needs.
 *
 * Boundaries are inclusive of their upper edge and are computed by shifting the
 * PROMISED date with `addDaysIso`, then comparing `yyyy-mm-dd` strings — so a
 * delivery on `expected_date + 3` is `days1to3`, and one on `+4` is `days4to7`.
 */
export type LatenessBands = {
  /** 1 to 3 days after the promised date. */
  days1to3: number;
  /** 4 to 7 days after. */
  days4to7: number;
  /** 8 or more days after. */
  days8plus: number;
};

export type DeliveryReliability = {
  /** POSTED goods received notes. A void or draft note is NOT a delivery. */
  deliveries: number;
  /**
   * Notes excluded from every figure above, surfaced so the exclusion is
   * visible rather than silent. A voided GRN counts for NOTHING: void-with-a-
   * reason is the correction path (20261059000000), so counting one would
   * penalise a supplier for our own data-entry fix.
   */
  excluded: { voided: number; draft: number };
  /** Distinct purchase orders that received at least one posted delivery. */
  ordersDelivered: number;
  /**
   * PUNCTUALITY. Denominator = posted deliveries whose order carried an
   * `expected_date`. `late` is the counted property.
   */
  punctuality: Ratio;
  onTime: number;
  lateBands: LatenessBands;
  /**
   * Posted deliveries on orders with NO promised date. Not late, not on time —
   * UNJUDGEABLE, and shown as such. Silently dropping these would let a
   * supplier's rate rest on a denominator the operator cannot see.
   */
  deliveriesWithoutPromisedDate: number;
  /**
   * SPLIT DELIVERIES. Denominator = orders with at least one posted delivery;
   * counted property = needed more than one delivery to arrive. An unambiguous
   * observed fact (extra site visits, extra handling) that needs no judgement
   * about whether an order is finished.
   */
  splitDeliveries: Ratio;
  /** Orders where every ordered line is now fully received. */
  ordersComplete: number;
  /**
   * Orders CANCELLED while still part-received — the order ended short.
   * Separated from `ordersInProgress` deliberately: see the note below.
   */
  ordersEndedShort: number;
  /**
   * Orders still part-received but NOT cancelled. These are NOT held against
   * the supplier and are excluded from every rate, because "part delivered" and
   * "part delivered SO FAR" are indistinguishable in this schema — the second
   * lorry may be booked for tomorrow. Counting an in-progress multi-drop order
   * as a short delivery is the single most likely way this feature would
   * produce a false accusation.
   */
  ordersInProgress: number;
};

/**
 * ONE counted delivery, with the verdict that put it in its bucket.
 *
 * This is the audit trail for the aggregate: the surface renders these as rows
 * linking to the order, so every number on the page can be clicked apart into
 * the records that produced it. A metric an operator cannot verify against the
 * paperwork is a metric they are being asked to take on faith, and this feature
 * is not entitled to any faith.
 *
 * `verdictOfDelivery` below is the SINGLE definition of the verdict, used by
 * both this list and the aggregate — the "two definitions of received that could
 * differ" trap that `po_receipt_state` documents.
 */
export type DeliveryRecord = {
  grnId: string;
  grnNumber: string | null;
  purchaseOrderId: string;
  poNumber: string | null;
  /** The promised date, or null when the order carried none / an unreadable one. */
  promised: string | null;
  delivered: string | null;
  verdict: "on_time" | "late" | "unjudgeable";
  /** Which lateness band, when late. Null otherwise. */
  band: keyof LatenessBands | null;
};

/** The one definition of a delivery's punctuality verdict. */
function verdictOfDelivery(
  promised: string | null | undefined,
  delivered: string | null | undefined,
): { verdict: DeliveryRecord["verdict"]; band: keyof LatenessBands | null } {
  if (!isIsoDate(promised) || !isIsoDate(delivered)) {
    return { verdict: "unjudgeable", band: null };
  }
  if (delivered <= promised) return { verdict: "on_time", band: null };
  if (delivered <= addDaysIso(promised, 3)) return { verdict: "late", band: "days1to3" };
  if (delivered <= addDaysIso(promised, 7)) return { verdict: "late", band: "days4to7" };
  return { verdict: "late", band: "days8plus" };
}

/**
 * Every POSTED delivery with its verdict, newest input order preserved.
 *
 * Void and draft notes are absent for the same reason they are absent from the
 * counts — they are not deliveries — so this list is exactly the evidence the
 * aggregate was computed from, and nothing else.
 */
export function listDeliveryRecords(input: {
  purchaseOrders: PerfPoRow[];
  grns: PerfGrnRow[];
}): DeliveryRecord[] {
  const poById = new Map(input.purchaseOrders.map((p) => [p.id, p]));
  const out: DeliveryRecord[] = [];
  for (const grn of input.grns) {
    if (grn.status !== "posted") continue;
    const po = poById.get(grn.purchase_order_id);
    if (!po) continue;
    const promised = po.expected_date ?? null;
    const { verdict, band } = verdictOfDelivery(promised, grn.delivery_date);
    out.push({
      grnId: grn.id,
      grnNumber: grn.number ?? null,
      purchaseOrderId: po.id,
      poNumber: po.number ?? null,
      promised: verdict === "unjudgeable" ? null : promised,
      delivered: grn.delivery_date,
      verdict,
      band,
    });
  }
  return out;
}

export function computeDeliveryReliability(input: {
  purchaseOrders: PerfPoRow[];
  grns: PerfGrnRow[];
  poLines: PerfPoLineRow[];
  grnLines: PerfGrnLineRow[];
}): DeliveryReliability {
  const poById = new Map(input.purchaseOrders.map((p) => [p.id, p]));

  // ONLY posted notes are deliveries. Void and draft are counted apart.
  //
  // Every bucket is gated on `poById.has(...)` — a note whose order is not in
  // this supplier's org-scoped set belongs to somebody else and may not appear
  // even in an exclusion count, which would otherwise reveal that another
  // company's delivery exists.
  const mine = input.grns.filter((g) => poById.has(g.purchase_order_id));
  const posted = mine.filter((g) => g.status === "posted");
  const voided = mine.filter((g) => g.status === "void").length;
  const draft = mine.filter((g) => g.status === "draft").length;

  let onTime = 0;
  let late = 0;
  let judgeable = 0;
  let unjudgeable = 0;
  const bands: LatenessBands = { days1to3: 0, days4to7: 0, days8plus: 0 };

  for (const grn of posted) {
    const po = poById.get(grn.purchase_order_id);
    // ONE definition of the verdict, shared with listDeliveryRecords, so the
    // evidence table can never disagree with the tile above it. An unreadable
    // date on either side is a promise we cannot check — not a pass and not a
    // failure.
    const { verdict, band } = verdictOfDelivery(po?.expected_date ?? null, grn.delivery_date);
    if (verdict === "unjudgeable") {
      unjudgeable += 1;
      continue;
    }
    judgeable += 1;
    if (verdict === "on_time") {
      onTime += 1;
      continue;
    }
    late += 1;
    if (band) bands[band] += 1;
  }

  // Deliveries per order, for the split-delivery count.
  const deliveriesPerOrder = new Map<string, number>();
  for (const grn of posted) {
    deliveriesPerOrder.set(
      grn.purchase_order_id,
      (deliveriesPerOrder.get(grn.purchase_order_id) ?? 0) + 1,
    );
  }

  // Receipt completeness, composed from computeReceiving (which mirrors
  // po_receipt_state) rather than re-counted here.
  // note id → PO id, for POSTED notes only. A received line hanging off a
  // voided or draft note resolves to nothing and is skipped, which is what
  // keeps a voided delivery from contributing quantity to receipt state.
  const poIdOfPostedNote = new Map(posted.map((g) => [g.id, g.purchase_order_id]));
  const receiptsByPo = new Map<string, PerfGrnLineRow[]>();
  for (const line of input.grnLines) {
    const poId = poIdOfPostedNote.get(line.goods_received_note_id);
    if (!poId) continue;
    const list = receiptsByPo.get(poId);
    if (list) list.push(line);
    else receiptsByPo.set(poId, [line]);
  }
  const linesByPo = new Map<string, PerfPoLineRow[]>();
  for (const line of input.poLines) {
    const list = linesByPo.get(line.purchase_order_id);
    if (list) list.push(line);
    else linesByPo.set(line.purchase_order_id, [line]);
  }

  let ordersComplete = 0;
  let ordersEndedShort = 0;
  let ordersInProgress = 0;
  for (const poId of deliveriesPerOrder.keys()) {
    const po = poById.get(poId);
    if (!po) continue;
    const state: PoReceiptStatus = computeReceiving({
      lines: (linesByPo.get(poId) ?? []).map((l) => ({
        id: l.id,
        description: l.description ?? "",
        unit: l.unit ?? null,
        qty: l.qty,
      })),
      receipts: (receiptsByPo.get(poId) ?? []).map((r) => ({
        purchase_order_line_item_id: r.purchase_order_line_item_id,
        qty_received: r.qty_received,
      })),
    }).status;

    if (state === "full") ordersComplete += 1;
    else if (po.status === "cancelled") ordersEndedShort += 1;
    else ordersInProgress += 1;
  }

  const ordersDelivered = deliveriesPerOrder.size;
  const split = [...deliveriesPerOrder.values()].filter((n) => n > 1).length;

  return {
    deliveries: posted.length,
    excluded: { voided, draft },
    ordersDelivered,
    punctuality: ratio(late, judgeable),
    onTime,
    lateBands: bands,
    deliveriesWithoutPromisedDate: unjudgeable,
    splitDeliveries: ratio(split, ordersDelivered),
    ordersComplete,
    ordersEndedShort,
    ordersInProgress,
  };
}

// ---------------------------------------------------------------------------
// Group B — price behaviour (what they billed vs what we ordered)
// ---------------------------------------------------------------------------

export type PriceBehaviour = {
  /**
   * OVER-BILLING. Denominator = orders with at least one bill linked; counted
   * property = the supplier has invoiced MORE than the order committed.
   * Composed from `computePoBilling`, whose `over_billed` verdict already
   * carries the ±0.005 tolerance so a penny of float noise is not a finding.
   */
  overBilled: Ratio;
  /** Orders invoiced up to, but not beyond, the committed total. */
  atOrUnderOrder: number;
  /**
   * Σ of the excess on over-billed orders, in pounds. An aggregate of observed
   * differences, each one `computePoBilling(...).remaining` negated — no new
   * money arithmetic, and `sumMoney` keeps it 2dp.
   */
  overBilledExcess: number;
  /**
   * Orders billed only in PART. NOT counted as under-charging: the rest of the
   * invoice may simply not have arrived yet, and treating a part-billed order
   * as a discount would flatter every supplier with slow paperwork.
   */
  partBilledOrders: number;
  /**
   * Bills for this supplier with NO purchase order attached. Price behaviour is
   * UNMEASURABLE for these — there is nothing to compare the invoice against —
   * so they are excluded from the denominator and reported here instead.
   */
  billsWithoutOrder: number;
};

export function computePriceBehaviour(input: {
  purchaseOrders: PerfPoRow[];
  bills: PerfBillRow[];
}): PriceBehaviour {
  const poById = new Map(input.purchaseOrders.map((p) => [p.id, p]));

  const billsByPo = new Map<string, PerfBillRow[]>();
  let billsWithoutOrder = 0;
  for (const bill of input.bills) {
    // A bill whose PO is absent from `purchaseOrders` is treated as unlinked
    // rather than dropped: the read layer scopes both sides to the ACTIVE org,
    // so the only way to reach this branch is a bill pointing at another
    // company's order — which must never contribute to this org's figures.
    const linked = bill.purchase_order_id;
    if (!linked || !poById.has(linked)) {
      billsWithoutOrder += 1;
      continue;
    }
    const list = billsByPo.get(linked);
    if (list) list.push(bill);
    else billsByPo.set(linked, [bill]);
  }

  let over = 0;
  let atOrUnder = 0;
  let partBilled = 0;
  const excesses: number[] = [];

  for (const [poId, bills] of billsByPo) {
    const po = poById.get(poId);
    if (!po) continue;
    const billing = computePoBilling({
      poTotal: po.total,
      bills: bills.map((b) => ({ amount: b.amount, vat_total: b.vat_total })),
    });
    if (billing.status === "over_billed") {
      over += 1;
      // `remaining` is poTotal − billedGross, so it is negative here; the
      // excess is its magnitude. No independent subtraction of our own.
      excesses.push(round2(-billing.remaining));
      continue;
    }
    atOrUnder += 1;
    if (billing.status === "part_billed") partBilled += 1;
  }

  return {
    overBilled: ratio(over, billsByPo.size),
    atOrUnderOrder: atOrUnder,
    overBilledExcess: sumMoney(excesses),
    partBilledOrders: partBilled,
    billsWithoutOrder,
  };
}

// ---------------------------------------------------------------------------
// Group C — how quickly WE settle their bills
// ---------------------------------------------------------------------------

/**
 * Days from the date on the supplier's invoice to the payment that finished
 * settling it, in bands.
 *
 * DELIBERATELY NOT CALLED "PAID ON TIME". Nothing in this schema stores an
 * agreed payment term: `finances` gained supplier_id, purchase_order_id,
 * reference and bill_date in 20261009000000 and NO due date, so "on time" has
 * no referent and any threshold would be one we invented. What IS observable is
 * elapsed days, so that is what this reports — and it is a measure of OUR
 * behaviour, not the supplier's, which is why it never appears alongside their
 * punctuality as though the two were comparable.
 *
 * It still belongs on a supplier's record: a merchant who waits 90 days for
 * money prices that in, and a subcontractor who does is a retention risk.
 */
export type SettlementSpeed = {
  /**
   * Bills counted. Denominator = bills FULLY settled (computeBillSettlements
   * status 'paid') that carry a readable `bill_date` and have a live payment
   * date to measure to.
   */
  n: number;
  bands: {
    within7: number;
    within30: number;
    within60: number;
    over60: number;
  };
  /**
   * Fully-settled bills EXCLUDED because the invoice carried no readable date,
   * so nothing can be measured from. Reported, never assumed to be fast.
   */
  excludedNoBillDate: number;
  /** Bills not yet fully settled — outside this measure by construction. */
  unsettledBills: number;
};

export function computeSettlementSpeed(input: {
  bills: PerfBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
}): SettlementSpeed {
  // WHICH bills are settled is decided by the settlement authority, not here.
  const settlements = computeBillSettlements(input);
  const paidBillIds = new Set(
    settlements.filter((s) => s.status === "paid" || s.status === "over_paid").map((s) => s.billId),
  );

  // Latest LIVE payment date per bill — the payment that finished it off.
  const livePaidAt = new Map<string, string>();
  for (const p of input.payments) {
    if (isLivePayment(p)) livePaidAt.set(p.id, p.paid_at);
  }
  const settledOn = new Map<string, string>();
  for (const alloc of input.allocations) {
    const paidAt = livePaidAt.get(alloc.payment_id);
    if (!paidAt) continue; // voided payment — settles nothing.
    const day = paidAt.slice(0, 10);
    const current = settledOn.get(alloc.finance_id);
    if (!current || day > current) settledOn.set(alloc.finance_id, day);
  }

  const bands = { within7: 0, within30: 0, within60: 0, over60: 0 };
  let n = 0;
  let excludedNoBillDate = 0;

  for (const bill of input.bills) {
    if (!paidBillIds.has(bill.id)) continue;
    const paidDay = settledOn.get(bill.id);
    const billed = bill.bill_date ?? null;
    if (!isIsoDate(billed) || !paidDay || !isIsoDate(paidDay)) {
      excludedNoBillDate += 1;
      continue;
    }
    n += 1;
    if (paidDay <= addDaysIso(billed, 7)) bands.within7 += 1;
    else if (paidDay <= addDaysIso(billed, 30)) bands.within30 += 1;
    else if (paidDay <= addDaysIso(billed, 60)) bands.within60 += 1;
    else bands.over60 += 1;
  }

  return {
    n,
    bands,
    excludedNoBillDate,
    unsettledBills: settlements.filter((s) => s.status !== "paid" && s.status !== "over_paid")
      .length,
  };
}

// ---------------------------------------------------------------------------
// The whole record
// ---------------------------------------------------------------------------

/**
 * One supplier's measured record.
 *
 * There is NO top-level score field and none may be added — see header note 2.
 * A caller that wants to rank suppliers picks a COLUMN and says which one it
 * picked.
 */
export type SupplierPerformance = {
  supplierId: string;
  supplierName: string;
  delivery: DeliveryReliability;
  price: PriceBehaviour;
  settlement: SettlementSpeed;
  /**
   * True when NOTHING measurable exists yet — no posted delivery, no
   * PO-linked bill, no settled bill. The surface shows an explicit "no record
   * yet" state rather than a wall of zeroes that reads like a bad record.
   */
  empty: boolean;
};

export function computeSupplierPerformance(input: {
  supplierId: string;
  supplierName: string;
  purchaseOrders: PerfPoRow[];
  grns: PerfGrnRow[];
  poLines: PerfPoLineRow[];
  grnLines: PerfGrnLineRow[];
  bills: PerfBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
}): SupplierPerformance {
  const delivery = computeDeliveryReliability(input);
  const price = computePriceBehaviour(input);
  const settlement = computeSettlementSpeed(input);

  return {
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    delivery,
    price,
    settlement,
    empty:
      delivery.deliveries === 0 &&
      price.overBilled.n === 0 &&
      settlement.n === 0 &&
      price.billsWithoutOrder === 0,
  };
}

// ---------------------------------------------------------------------------
// Display helpers — wording that cannot overstate the evidence
// ---------------------------------------------------------------------------

/**
 * A rate, or the reason there isn't one. NEVER returns a bare percentage for a
 * sample below the convention, which is what makes the honest string the
 * DEFAULT rather than something each surface has to remember.
 */
export function formatRate(r: Ratio): string {
  if (r.n === 0) return "No comparable records";
  if (!isRated(r)) return `${r.count} of ${r.n} — too few to rate`;
  return `${r.pct}% (${r.count} of ${r.n})`;
}

/** The always-safe short form for a table cell: "3/12" plus a rate if earned. */
export function formatRateCompact(r: Ratio): string {
  if (r.n === 0) return "—";
  if (!isRated(r)) return `${r.count}/${r.n}`;
  return `${r.pct}% · ${r.count}/${r.n}`;
}

/**
 * The sample-size caveat for a ratio, or null when the sample is adequate.
 * Rendered next to every unrated figure.
 */
export function sampleCaveat(r: Ratio): string | null {
  if (r.n === 0) return "Nothing comparable recorded yet.";
  if (r.rated) return null;
  return `Only ${r.n} comparable record${r.n === 1 ? "" : "s"} — fewer than ${MIN_RATED_SAMPLE}, so no rate is shown.`;
}

export const LATENESS_BAND_LABEL: Record<keyof LatenessBands, string> = {
  days1to3: "1 to 3 days late",
  days4to7: "4 to 7 days late",
  days8plus: "8+ days late",
};

export const SETTLEMENT_BAND_LABEL: Record<keyof SettlementSpeed["bands"], string> = {
  within7: "Within 7 days",
  within30: "8 to 30 days",
  within60: "31 to 60 days",
  over60: "Over 60 days",
};
