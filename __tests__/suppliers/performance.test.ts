import { describe, expect, it } from "vitest";
import {
  MIN_RATED_SAMPLE,
  computeDeliveryReliability,
  computePriceBehaviour,
  computeSettlementSpeed,
  computeSupplierPerformance,
  formatRate,
  formatRateCompact,
  isRated,
  listDeliveryRecords,
  ratio,
  sampleCaveat,
  type PerfBillRow,
  type PerfGrnLineRow,
  type PerfGrnRow,
  type PerfPoLineRow,
  type PerfPoRow,
} from "@/lib/suppliers/performance";

/**
 * Supplier performance — the measurement arithmetic (lib/suppliers/performance.ts).
 *
 * Phase 9 requires DETERMINISTIC metrics that are never labelled as prediction,
 * so the cases below are the ones that would let this feature LIE about a real
 * company: a voided delivery counted as a late one, a rate published off one
 * observation, an in-progress multi-drop order recorded as a short delivery, and
 * an off-by-one on a lateness band boundary.
 */

// ---------------------------------------------------------------------------
// The sample-size convention — the guard against libel
// ---------------------------------------------------------------------------

describe("ratio + the minimum-n convention", () => {
  it("withholds the rate entirely below the minimum sample", () => {
    // "100% late" off ONE delivery is the headline this convention exists to
    // prevent. pct must be null — not 0, not 100, not NaN.
    const one = ratio(1, 1);
    expect(one.count).toBe(1);
    expect(one.n).toBe(1);
    expect(one.pct).toBeNull();
    expect(one.rated).toBe(false);
    expect(isRated(one)).toBe(false);
  });

  it("publishes the rate at exactly the minimum sample, and not one below", () => {
    expect(MIN_RATED_SAMPLE).toBe(5);
    const below = ratio(2, MIN_RATED_SAMPLE - 1);
    expect(below.pct).toBeNull();
    expect(below.rated).toBe(false);

    const at = ratio(2, MIN_RATED_SAMPLE);
    expect(at.pct).toBe(40);
    expect(at.rated).toBe(true);
    expect(isRated(at)).toBe(true);
  });

  it("treats an empty sample as unrated rather than 0%", () => {
    // A supplier we have never received from is not a supplier with a 0% late
    // rate — collapsing those two makes an untried merchant look proven.
    const none = ratio(0, 0);
    expect(none.pct).toBeNull();
    expect(none.rated).toBe(false);
    expect(formatRate(none)).toBe("No comparable records");
    expect(formatRateCompact(none)).toBe("—");
  });

  it("never formats a percentage it has not earned", () => {
    expect(formatRate(ratio(1, 2))).toBe("1 of 2 — too few to rate");
    expect(formatRateCompact(ratio(1, 2))).toBe("1/2");
    expect(formatRate(ratio(3, 10))).toBe("30% (3 of 10)");
    expect(formatRateCompact(ratio(3, 10))).toBe("30% · 3/10");
  });

  it("explains the suppression, with correct pluralisation", () => {
    expect(sampleCaveat(ratio(0, 0))).toBe("Nothing comparable recorded yet.");
    expect(sampleCaveat(ratio(1, 1))).toContain("Only 1 comparable record —");
    expect(sampleCaveat(ratio(1, 1))).toContain("fewer than 5");
    expect(sampleCaveat(ratio(1, 3))).toContain("Only 3 comparable records —");
    // An adequate sample needs no caveat at all.
    expect(sampleCaveat(ratio(1, 5))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delivery reliability
// ---------------------------------------------------------------------------

const PO = (over: Partial<PerfPoRow> & { id: string }): PerfPoRow => ({
  number: `PO-${over.id}`,
  status: "sent",
  expected_date: "2026-06-10",
  total: 1000,
  ...over,
});

const GRN = (over: Partial<PerfGrnRow> & { id: string; purchase_order_id: string }): PerfGrnRow => ({
  status: "posted",
  delivery_date: "2026-06-10",
  ...over,
});

describe("computeDeliveryReliability — what counts as a delivery", () => {
  it("counts POSTED notes only, and reports the exclusions", () => {
    // A VOIDED GRN must not count as a delivery: void-with-a-reason is the
    // correction path (20261059000000), so counting one would score a supplier
    // down for OUR data-entry fix. A draft has not happened yet.
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1" })],
      grns: [
        GRN({ id: "g1", purchase_order_id: "po1", delivery_date: "2026-06-20" }),
        GRN({ id: "g2", purchase_order_id: "po1", status: "void", delivery_date: "2026-06-25" }),
        GRN({ id: "g3", purchase_order_id: "po1", status: "draft", delivery_date: "2026-06-26" }),
      ],
      poLines: [],
      grnLines: [],
    });

    expect(r.deliveries).toBe(1);
    expect(r.excluded).toEqual({ voided: 1, draft: 1 });
    // The voided late delivery contributed NOTHING to punctuality.
    expect(r.punctuality.n).toBe(1);
    expect(r.punctuality.count).toBe(1);
  });

  it("ignores a note whose purchase order is not in the supplier's set", () => {
    // The read layer scopes both sides to the active org, so this is the
    // in-memory half of the same guarantee: a GRN with no matching PO here is a
    // GRN belonging to somebody else's order and may not be counted — not even
    // in an exclusion count, which would leak that it exists.
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "mine" })],
      grns: [
        GRN({ id: "g1", purchase_order_id: "mine" }),
        GRN({ id: "g2", purchase_order_id: "theirs" }),
        GRN({ id: "g3", purchase_order_id: "theirs", status: "void" }),
        GRN({ id: "g4", purchase_order_id: "theirs", status: "draft" }),
      ],
      poLines: [],
      grnLines: [],
    });
    expect(r.deliveries).toBe(1);
    expect(r.excluded).toEqual({ voided: 0, draft: 0 });
  });
});

describe("computeDeliveryReliability — punctuality", () => {
  it("treats delivery ON the promised date as on time", () => {
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1", expected_date: "2026-06-10" })],
      grns: [GRN({ id: "g1", purchase_order_id: "po1", delivery_date: "2026-06-10" })],
      poLines: [],
      grnLines: [],
    });
    expect(r.onTime).toBe(1);
    expect(r.punctuality.count).toBe(0);
    expect(r.punctuality.n).toBe(1);
  });

  it("bands lateness on the boundaries, inclusive of the upper edge", () => {
    // The boundaries are the whole point: a delivery on expected+3 is "1–3
    // days", on +4 it is "4–7". An off-by-one here silently reclassifies a
    // supplier's worst deliveries as their mildest.
    const promised = "2026-06-10";
    const r = computeDeliveryReliability({
      purchaseOrders: [
        PO({ id: "a", expected_date: promised }),
        PO({ id: "b", expected_date: promised }),
        PO({ id: "c", expected_date: promised }),
        PO({ id: "d", expected_date: promised }),
        PO({ id: "e", expected_date: promised }),
      ],
      grns: [
        GRN({ id: "g1", purchase_order_id: "a", delivery_date: "2026-06-11" }), // +1
        GRN({ id: "g2", purchase_order_id: "b", delivery_date: "2026-06-13" }), // +3
        GRN({ id: "g3", purchase_order_id: "c", delivery_date: "2026-06-14" }), // +4
        GRN({ id: "g4", purchase_order_id: "d", delivery_date: "2026-06-17" }), // +7
        GRN({ id: "g5", purchase_order_id: "e", delivery_date: "2026-06-18" }), // +8
      ],
      poLines: [],
      grnLines: [],
    });

    expect(r.lateBands).toEqual({ days1to3: 2, days4to7: 2, days8plus: 1 });
    expect(r.punctuality.count).toBe(5);
    expect(r.punctuality.n).toBe(5);
    expect(r.punctuality.pct).toBe(100);
  });

  it("crosses a month boundary correctly", () => {
    // Plain-date arithmetic via addDaysIso, not millisecond maths: 30 June + 3
    // is 3 July, and a delivery on 4 July is therefore 4–7 days late.
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "a", expected_date: "2026-06-30" })],
      grns: [GRN({ id: "g1", purchase_order_id: "a", delivery_date: "2026-07-04" })],
      poLines: [],
      grnLines: [],
    });
    expect(r.lateBands).toEqual({ days1to3: 0, days4to7: 1, days8plus: 0 });
  });

  it("excludes deliveries with no promised date instead of scoring them", () => {
    // An order with no expected_date carries no promise, so the delivery is
    // neither on time nor late. Counting it either way would invent a promise.
    const r = computeDeliveryReliability({
      purchaseOrders: [
        PO({ id: "dated", expected_date: "2026-06-10" }),
        PO({ id: "undated", expected_date: null }),
      ],
      grns: [
        GRN({ id: "g1", purchase_order_id: "dated", delivery_date: "2026-06-20" }),
        GRN({ id: "g2", purchase_order_id: "undated", delivery_date: "2026-06-20" }),
      ],
      poLines: [],
      grnLines: [],
    });

    expect(r.deliveries).toBe(2);
    expect(r.punctuality.n).toBe(1);
    expect(r.deliveriesWithoutPromisedDate).toBe(1);
    expect(r.onTime + r.punctuality.count).toBe(r.punctuality.n);
  });

  it("excludes unreadable dates rather than guessing at them", () => {
    const r = computeDeliveryReliability({
      purchaseOrders: [
        PO({ id: "a", expected_date: "not-a-date" }),
        PO({ id: "b", expected_date: "2026-02-30" }), // impossible day
        PO({ id: "c", expected_date: "2026-06-10" }),
      ],
      grns: [
        GRN({ id: "g1", purchase_order_id: "a", delivery_date: "2026-06-20" }),
        GRN({ id: "g2", purchase_order_id: "b", delivery_date: "2026-06-20" }),
        GRN({ id: "g3", purchase_order_id: "c", delivery_date: null }),
      ],
      poLines: [],
      grnLines: [],
    });
    expect(r.punctuality.n).toBe(0);
    expect(r.deliveriesWithoutPromisedDate).toBe(3);
  });
});

describe("computeDeliveryReliability — completeness and split deliveries", () => {
  const LINES: PerfPoLineRow[] = [
    { id: "l1", purchase_order_id: "po1", description: "Blocks", qty: 100, unit: "ea" },
    { id: "l2", purchase_order_id: "po1", description: "Sand", qty: 10, unit: "t" },
  ];

  it("counts an order as complete only when every line is satisfied", () => {
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1", status: "received" })],
      grns: [GRN({ id: "g1", purchase_order_id: "po1" })],
      poLines: LINES,
      grnLines: [
        { goods_received_note_id: "g1", purchase_order_line_item_id: "l1", qty_received: 100 },
        { goods_received_note_id: "g1", purchase_order_line_item_id: "l2", qty_received: 10 },
      ],
    });
    expect(r.ordersComplete).toBe(1);
    expect(r.ordersInProgress).toBe(0);
    expect(r.ordersEndedShort).toBe(0);
  });

  it("does NOT hold a part-received live order against the supplier", () => {
    // "Part delivered" and "part delivered SO FAR" are indistinguishable in
    // this schema — the second lorry may be booked for tomorrow. An open order
    // is therefore in progress, never a short delivery.
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1", status: "partially_received" })],
      grns: [GRN({ id: "g1", purchase_order_id: "po1" })],
      poLines: LINES,
      grnLines: [
        { goods_received_note_id: "g1", purchase_order_line_item_id: "l1", qty_received: 40 },
      ],
    });
    expect(r.ordersInProgress).toBe(1);
    expect(r.ordersEndedShort).toBe(0);
    expect(r.ordersComplete).toBe(0);
  });

  it("counts an order CANCELLED while part-received as having ended short", () => {
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1", status: "cancelled" })],
      grns: [GRN({ id: "g1", purchase_order_id: "po1" })],
      poLines: LINES,
      grnLines: [
        { goods_received_note_id: "g1", purchase_order_line_item_id: "l1", qty_received: 40 },
      ],
    });
    expect(r.ordersEndedShort).toBe(1);
    expect(r.ordersInProgress).toBe(0);
  });

  it("ignores received lines that hang off a voided note", () => {
    // The void must remove the QUANTITY too, not just the delivery count —
    // otherwise a voided over-receipt keeps an order looking complete.
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1", status: "partially_received" })],
      grns: [
        GRN({ id: "g1", purchase_order_id: "po1" }),
        GRN({ id: "gvoid", purchase_order_id: "po1", status: "void" }),
      ],
      poLines: LINES,
      grnLines: [
        { goods_received_note_id: "g1", purchase_order_line_item_id: "l1", qty_received: 100 },
        // Voided: the sand never really arrived.
        { goods_received_note_id: "gvoid", purchase_order_line_item_id: "l2", qty_received: 10 },
      ],
    });
    expect(r.ordersComplete).toBe(0);
    expect(r.ordersInProgress).toBe(1);
  });

  it("partitions every delivered order into exactly one completeness bucket", () => {
    // complete + ended-short + in-progress must equal orders delivered. If they
    // ever disagree, an order has either been double-counted or has fallen
    // through the cracks — and a missing order silently shrinks a denominator.
    const purchaseOrders: PerfPoRow[] = [
      PO({ id: "done", status: "received" }),
      PO({ id: "open", status: "partially_received" }),
      PO({ id: "killed", status: "cancelled" }),
    ];
    const grns: PerfGrnRow[] = [
      GRN({ id: "g1", purchase_order_id: "done" }),
      GRN({ id: "g2", purchase_order_id: "open" }),
      GRN({ id: "g3", purchase_order_id: "killed" }),
    ];
    const poLines: PerfPoLineRow[] = [
      { id: "d1", purchase_order_id: "done", qty: 10 },
      { id: "o1", purchase_order_id: "open", qty: 10 },
      { id: "k1", purchase_order_id: "killed", qty: 10 },
    ];
    const r = computeDeliveryReliability({
      purchaseOrders,
      grns,
      poLines,
      grnLines: [
        { goods_received_note_id: "g1", purchase_order_line_item_id: "d1", qty_received: 10 },
        { goods_received_note_id: "g2", purchase_order_line_item_id: "o1", qty_received: 4 },
        { goods_received_note_id: "g3", purchase_order_line_item_id: "k1", qty_received: 4 },
      ],
    });

    expect(r.ordersComplete).toBe(1);
    expect(r.ordersInProgress).toBe(1);
    expect(r.ordersEndedShort).toBe(1);
    expect(r.ordersComplete + r.ordersInProgress + r.ordersEndedShort).toBe(r.ordersDelivered);
  });

  it("counts orders that needed more than one delivery", () => {
    const r = computeDeliveryReliability({
      purchaseOrders: [PO({ id: "po1" }), PO({ id: "po2" })],
      grns: [
        GRN({ id: "g1", purchase_order_id: "po1" }),
        GRN({ id: "g2", purchase_order_id: "po1" }),
        GRN({ id: "g3", purchase_order_id: "po2" }),
      ],
      poLines: [],
      grnLines: [],
    });
    expect(r.ordersDelivered).toBe(2);
    expect(r.splitDeliveries.count).toBe(1);
    expect(r.splitDeliveries.n).toBe(2);
    // Two orders is below the convention, so no rate is published.
    expect(r.splitDeliveries.pct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The evidence table must reconcile with the aggregate
// ---------------------------------------------------------------------------

describe("listDeliveryRecords reconciles with the aggregate", () => {
  // A deliberately awkward mix: on time, every lateness band, an undated order,
  // an unreadable date, a void and a draft.
  const purchaseOrders: PerfPoRow[] = [
    PO({ id: "a", expected_date: "2026-06-10" }),
    PO({ id: "b", expected_date: "2026-06-10" }),
    PO({ id: "c", expected_date: "2026-06-10" }),
    PO({ id: "d", expected_date: "2026-06-10" }),
    PO({ id: "e", expected_date: null }),
    PO({ id: "f", expected_date: "nonsense" }),
  ];
  const grns: PerfGrnRow[] = [
    GRN({ id: "g1", purchase_order_id: "a", delivery_date: "2026-06-09" }), // on time
    GRN({ id: "g2", purchase_order_id: "b", delivery_date: "2026-06-12" }), // 1-3
    GRN({ id: "g3", purchase_order_id: "c", delivery_date: "2026-06-15" }), // 4-7
    GRN({ id: "g4", purchase_order_id: "d", delivery_date: "2026-06-30" }), // 8+
    GRN({ id: "g5", purchase_order_id: "e", delivery_date: "2026-06-30" }), // unjudgeable
    GRN({ id: "g6", purchase_order_id: "f", delivery_date: "2026-06-30" }), // unjudgeable
    GRN({ id: "g7", purchase_order_id: "a", status: "void", delivery_date: "2026-07-30" }),
    GRN({ id: "g8", purchase_order_id: "a", status: "draft", delivery_date: "2026-07-30" }),
  ];

  const records = listDeliveryRecords({ purchaseOrders, grns });
  const aggregate = computeDeliveryReliability({ purchaseOrders, grns, poLines: [], grnLines: [] });

  it("lists exactly the deliveries the aggregate counted", () => {
    expect(records).toHaveLength(aggregate.deliveries);
    // Neither the void nor the draft appears as evidence.
    expect(records.map((r) => r.grnId)).not.toContain("g7");
    expect(records.map((r) => r.grnId)).not.toContain("g8");
  });

  it("agrees on every verdict count", () => {
    const late = records.filter((r) => r.verdict === "late");
    expect(records.filter((r) => r.verdict === "on_time")).toHaveLength(aggregate.onTime);
    expect(late).toHaveLength(aggregate.punctuality.count);
    expect(records.filter((r) => r.verdict === "unjudgeable")).toHaveLength(
      aggregate.deliveriesWithoutPromisedDate,
    );
    // The bands partition the late set exactly.
    for (const band of ["days1to3", "days4to7", "days8plus"] as const) {
      expect(late.filter((r) => r.band === band)).toHaveLength(aggregate.lateBands[band]);
    }
    const banded = Object.values(aggregate.lateBands).reduce((a, b) => a + b, 0);
    expect(banded).toBe(aggregate.punctuality.count);
  });

  it("hides the promised date on a record it could not judge", () => {
    // Showing "promised: nonsense" next to "unjudgeable" invites the reader to
    // do the comparison the code refused to do.
    for (const r of records.filter((r) => r.verdict === "unjudgeable")) {
      expect(r.promised).toBeNull();
    }
  });

  it("accounts for every delivery exactly once", () => {
    expect(aggregate.onTime + aggregate.punctuality.count + aggregate.deliveriesWithoutPromisedDate)
      .toBe(aggregate.deliveries);
  });
});

// ---------------------------------------------------------------------------
// Price behaviour
// ---------------------------------------------------------------------------

const BILL = (over: Partial<PerfBillRow> & { id: string }): PerfBillRow => ({
  amount: 100,
  vat_total: 20,
  bill_date: "2026-06-01",
  purchase_order_id: null,
  ...over,
});

describe("computePriceBehaviour", () => {
  it("counts an order the supplier invoiced beyond its committed total", () => {
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "po1", total: 120 })],
      bills: [BILL({ id: "b1", purchase_order_id: "po1", amount: 200, vat_total: 40 })],
    });
    expect(r.overBilled.count).toBe(1);
    expect(r.overBilled.n).toBe(1);
    expect(r.overBilled.pct).toBeNull(); // one order earns no rate
    expect(r.overBilledExcess).toBe(120); // 240 billed gross vs 120 ordered
  });

  it("does NOT treat a part-billed order as under-charging", () => {
    // The rest of the invoice may simply not have arrived. Counting the
    // shortfall as a discount would flatter every supplier with slow paperwork.
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "po1", total: 1200 })],
      bills: [BILL({ id: "b1", purchase_order_id: "po1", amount: 100, vat_total: 20 })],
    });
    expect(r.overBilled.count).toBe(0);
    expect(r.atOrUnderOrder).toBe(1);
    expect(r.partBilledOrders).toBe(1);
    expect(r.overBilledExcess).toBe(0);
  });

  it("excludes bills with no purchase order from the denominator", () => {
    // There is nothing to compare an ad-hoc invoice against, so it cannot be
    // evidence of price behaviour either way — but the operator must see how
    // much of the trading history that removes.
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "po1", total: 120 })],
      bills: [
        BILL({ id: "b1", purchase_order_id: "po1" }),
        BILL({ id: "b2" }),
        BILL({ id: "b3", purchase_order_id: null }),
      ],
    });
    expect(r.overBilled.n).toBe(1);
    expect(r.billsWithoutOrder).toBe(2);
  });

  it("treats a bill pointing at an unknown order as unlinked, never as a finding", () => {
    // Reachable only if a bill points at another company's order; it must not
    // contribute to this org's figures.
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "mine", total: 120 })],
      bills: [BILL({ id: "b1", purchase_order_id: "theirs", amount: 9999 })],
    });
    expect(r.overBilled.n).toBe(0);
    expect(r.overBilledExcess).toBe(0);
    expect(r.billsWithoutOrder).toBe(1);
  });

  it("sums several bills against one order before judging it", () => {
    // Two invoices of £60 gross against a £120 order is FULLY billed, not two
    // part-bills and certainly not an over-bill.
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "po1", total: 120 })],
      bills: [
        BILL({ id: "b1", purchase_order_id: "po1", amount: 50, vat_total: 10 }),
        BILL({ id: "b2", purchase_order_id: "po1", amount: 50, vat_total: 10 }),
      ],
    });
    expect(r.overBilled.n).toBe(1);
    expect(r.overBilled.count).toBe(0);
    expect(r.partBilledOrders).toBe(0);
  });

  it("does not read a penny of rounding noise as over-billing", () => {
    const r = computePriceBehaviour({
      purchaseOrders: [PO({ id: "po1", total: "120.00" })],
      bills: [BILL({ id: "b1", purchase_order_id: "po1", amount: "100.00", vat_total: "20.00" })],
    });
    expect(r.overBilled.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Settlement speed — OUR behaviour, and never called "on time"
// ---------------------------------------------------------------------------

describe("computeSettlementSpeed", () => {
  const paidBill = (id: string, billDate: string): PerfBillRow =>
    BILL({ id, amount: 100, vat_total: 20, bill_date: billDate });

  it("bands elapsed days from the invoice date to the settling payment", () => {
    const r = computeSettlementSpeed({
      bills: [
        paidBill("b1", "2026-06-01"),
        paidBill("b2", "2026-06-01"),
        paidBill("b3", "2026-06-01"),
        paidBill("b4", "2026-06-01"),
      ],
      payments: [
        { id: "p1", paid_at: "2026-06-08T00:00:00Z", method: "bank_transfer", reference: null, gross_amount: 120, cis_withheld: 0, net_paid: 120 },
        { id: "p2", paid_at: "2026-07-01T00:00:00Z", method: "bank_transfer", reference: null, gross_amount: 120, cis_withheld: 0, net_paid: 120 },
        { id: "p3", paid_at: "2026-07-25T00:00:00Z", method: "bank_transfer", reference: null, gross_amount: 120, cis_withheld: 0, net_paid: 120 },
        { id: "p4", paid_at: "2026-09-01T00:00:00Z", method: "bank_transfer", reference: null, gross_amount: 120, cis_withheld: 0, net_paid: 120 },
      ],
      allocations: [
        { payment_id: "p1", finance_id: "b1", amount: 120 }, // +7  → within7
        { payment_id: "p2", finance_id: "b2", amount: 120 }, // +30 → within30
        { payment_id: "p3", finance_id: "b3", amount: 120 }, // +54 → within60
        { payment_id: "p4", finance_id: "b4", amount: 120 }, // +92 → over60
      ],
    });

    expect(r.n).toBe(4);
    expect(r.bands).toEqual({ within7: 1, within30: 1, within60: 1, over60: 1 });
    expect(r.unsettledBills).toBe(0);
  });

  it("measures to the LAST live payment when a bill was settled in instalments", () => {
    const r = computeSettlementSpeed({
      bills: [paidBill("b1", "2026-06-01")],
      payments: [
        { id: "p1", paid_at: "2026-06-02T00:00:00Z", method: "cash", reference: null, gross_amount: 60, cis_withheld: 0, net_paid: 60 },
        { id: "p2", paid_at: "2026-08-01T00:00:00Z", method: "cash", reference: null, gross_amount: 60, cis_withheld: 0, net_paid: 60 },
      ],
      allocations: [
        { payment_id: "p1", finance_id: "b1", amount: 60 },
        { payment_id: "p2", finance_id: "b1", amount: 60 },
      ],
    });
    // The bill was not settled until the SECOND payment, 61 days later.
    expect(r.n).toBe(1);
    expect(r.bands.over60).toBe(1);
    expect(r.bands.within7).toBe(0);
  });

  it("ignores voided payments — they settle nothing and time nothing", () => {
    const r = computeSettlementSpeed({
      bills: [paidBill("b1", "2026-06-01")],
      payments: [
        {
          id: "p1",
          paid_at: "2026-06-02T00:00:00Z",
          method: "cash",
          reference: null,
          gross_amount: 120,
          cis_withheld: 0,
          net_paid: 120,
          voided_at: "2026-06-03T00:00:00Z",
          void_reason: "keyed twice",
        },
      ],
      allocations: [{ payment_id: "p1", finance_id: "b1", amount: 120 }],
    });
    // The bill is NOT settled once the payment is void, so it leaves the
    // measure entirely rather than appearing as a fast settlement.
    expect(r.n).toBe(0);
    expect(r.unsettledBills).toBe(1);
  });

  it("excludes a settled bill with no readable invoice date", () => {
    const r = computeSettlementSpeed({
      bills: [BILL({ id: "b1", bill_date: null }), BILL({ id: "b2", bill_date: "garbage" })],
      payments: [
        { id: "p1", paid_at: "2026-06-08T00:00:00Z", method: "cash", reference: null, gross_amount: 240, cis_withheld: 0, net_paid: 240 },
      ],
      allocations: [
        { payment_id: "p1", finance_id: "b1", amount: 120 },
        { payment_id: "p1", finance_id: "b2", amount: 120 },
      ],
    });
    expect(r.n).toBe(0);
    expect(r.excludedNoBillDate).toBe(2);
  });

  it("leaves unsettled bills out of the measure by construction", () => {
    const r = computeSettlementSpeed({
      bills: [paidBill("b1", "2026-06-01")],
      payments: [
        { id: "p1", paid_at: "2026-06-02T00:00:00Z", method: "cash", reference: null, gross_amount: 60, cis_withheld: 0, net_paid: 60 },
      ],
      allocations: [{ payment_id: "p1", finance_id: "b1", amount: 60 }], // half of 120
    });
    expect(r.n).toBe(0);
    expect(r.unsettledBills).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The whole record
// ---------------------------------------------------------------------------

describe("computeSupplierPerformance", () => {
  const EMPTY = {
    purchaseOrders: [] as PerfPoRow[],
    grns: [] as PerfGrnRow[],
    poLines: [] as PerfPoLineRow[],
    grnLines: [] as PerfGrnLineRow[],
    bills: [] as PerfBillRow[],
    payments: [],
    allocations: [],
  };

  it("flags a supplier with nothing measurable as empty", () => {
    const r = computeSupplierPerformance({ supplierId: "s1", supplierName: "Untried Ltd", ...EMPTY });
    expect(r.empty).toBe(true);
    expect(r.delivery.deliveries).toBe(0);
  });

  it("is not empty once anything measurable exists", () => {
    const r = computeSupplierPerformance({
      supplierId: "s1",
      supplierName: "Traded Ltd",
      ...EMPTY,
      purchaseOrders: [PO({ id: "po1" })],
      grns: [GRN({ id: "g1", purchase_order_id: "po1" })],
    });
    expect(r.empty).toBe(false);
  });

  it("exposes NO composite score field of any kind", () => {
    // Phase 9's constraint, asserted structurally. A single number would need
    // weights nothing in this database knows, so the shape must not offer a
    // place to put one — this fails the moment somebody adds it.
    const r = computeSupplierPerformance({ supplierId: "s1", supplierName: "X", ...EMPTY });
    const keys = Object.keys(r);
    expect(keys.sort()).toEqual(
      ["delivery", "empty", "price", "settlement", "supplierId", "supplierName"].sort(),
    );
    for (const banned of ["score", "rating", "grade", "stars", "rank", "index", "prediction"]) {
      expect(keys, `a composite '${banned}' appeared on the record`).not.toContain(banned);
    }
  });
});
