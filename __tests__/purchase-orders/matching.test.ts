import { describe, expect, it } from "vitest";
import {
  compareMatchSeverity,
  describeFinding,
  matchThreeWay,
  MATCH_STATE_LABEL,
  MATCH_STATE_RANK,
  NO_TOLERANCE_POLICY,
  type MatchBill,
  type MatchGrn,
  type MatchOrderedLine,
  type ThreeWayMatch,
} from "@/lib/purchase-orders/matching";
import { computeTotals } from "@/lib/quotes/totals";

/**
 * THREE-WAY MATCH — ordered vs received vs billed.
 *
 * The reference order (PO-0001) throughout:
 *   L1  10 ea @ £100.00 @ 20% → net £1,000.00 vat £200.00 gross £1,200.00
 *   L2   4 ea @  £50.00 @ 20% → net   £200.00 vat  £40.00 gross   £240.00
 *                                     ───────       ──────        ────────
 *                               order net £1,200.00 vat £240.00 gross £1,440.00
 *
 * Every assertion below states an exact penny figure. That is the point of the
 * module: no bands, no "approximately", no tolerance.
 */

const PO = "po-1";

const LINES: MatchOrderedLine[] = [
  { id: "l1", description: "Concrete blocks", unit: "ea", qty: 10, unit_price: 100, vat_rate: 20, sort_order: 0 },
  { id: "l2", description: "Sand", unit: "ea", qty: 4, unit_price: 50, vat_rate: 20, sort_order: 1 },
];

const ORDER_NET = 1200;
const ORDER_VAT = 240;
const ORDER_GROSS = 1440;

function grn(
  id: string,
  status: string,
  lines: Array<[string, number]>,
  delivery_date = "2026-06-01",
): MatchGrn {
  return {
    id,
    number: id.toUpperCase(),
    status,
    delivery_date,
    lines: lines.map(([purchase_order_line_item_id, qty_received]) => ({
      purchase_order_line_item_id,
      qty_received,
    })),
  };
}

/** A bill on THIS order. `amount` is net; `vat_total` is the generated column. */
function bill(id: string, net: number, vat: number, po: string | null = PO): MatchBill {
  return { id, purchase_order_id: po, amount: net, vat_total: vat, reference: `INV-${id}` };
}

const match = (input: {
  lines?: MatchOrderedLine[];
  grns?: MatchGrn[];
  bills?: MatchBill[];
  cancelled?: boolean;
}) =>
  matchThreeWay({
    poId: PO,
    lines: input.lines ?? LINES,
    grns: input.grns ?? [],
    bills: input.bills ?? [],
    cancelled: input.cancelled,
  });

// ---------------------------------------------------------------------------
// 1. The ordered leg IS the stored PO total — one rounding authority
// ---------------------------------------------------------------------------

describe("the ordered leg is valued by the same authority that stored the PO total", () => {
  it("equals computeTotals over the same lines, to the penny", () => {
    // If these two ever diverged, a multi-line order would show a penny of
    // "variance" that is really a rounding fork between two bits of code.
    const stored = computeTotals(
      LINES.map((l) => ({
        description: l.description,
        unit: "ea",
        qty: Number(l.qty),
        unit_price: Number(l.unit_price),
        vat_rate: Number(l.vat_rate),
      })),
    );
    const r = match({});
    expect(r.ordered).toEqual({ net: stored.subtotal, vat: stored.vat_total, gross: stored.total });
    expect(r.ordered.gross).toBe(ORDER_GROSS);
  });

  it("values the received leg with the identical per-line-VAT algorithm", () => {
    // Half of every line delivered → exactly half the money, no drift.
    const r = match({ grns: [grn("g1", "posted", [["l1", 5], ["l2", 2]])] });
    expect(r.received).toEqual({ net: 600, vat: 120, gross: 720 });
  });
});

// ---------------------------------------------------------------------------
// 2. The five states
// ---------------------------------------------------------------------------

describe("state: open", () => {
  it("nothing received and nothing billed is an OPEN order, not a discrepancy", () => {
    const r = match({});
    expect(r.state).toBe("open");
    expect(r.isDiscrepancy).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.worstVariance).toBe(0);
    expect(r.received.gross).toBe(0);
    expect(r.billed.gross).toBe(0);
    expect(r.receiptStatus).toBe("none");
  });
});

describe("state: matched", () => {
  it("all three legs agreeing to the penny is MATCHED", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", ORDER_NET, ORDER_VAT)],
    });
    expect(r.state).toBe("matched");
    expect(r.isDiscrepancy).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.billedVsOrdered).toBe(0);
    expect(r.billedVsReceived).toBe(0);
    expect(r.accrual).toBe(0);
    expect(r.receiptStatus).toBe("full");
  });

  it("stays matched when the bill arrives split across several invoices", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", 1000, 200), bill("b2", 200, 40)],
    });
    expect(r.billed).toEqual({ net: 1200, vat: 240, gross: 1440 });
    expect(r.billCount).toBe(2);
    expect(r.state).toBe("matched");
  });
});

describe("state: over_billed — the supplier invoiced more than was ordered", () => {
  const r = match({
    grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
    bills: [bill("b1", 1300, 260)], // £1,560 gross
  });

  it("reports the exact overage, gross AND net", () => {
    expect(r.state).toBe("over_billed");
    expect(r.isDiscrepancy).toBe(true);
    expect(r.billed.gross).toBe(1560);
    expect(r.billedVsOrdered).toBe(120);
    const f = r.findings.find((x) => x.kind === "over_billed");
    expect(f).toBeDefined();
    expect(f?.gross).toBe(120);
    expect(f?.net).toBe(100);
  });

  it("carries no quantity on the over-billed finding — a bill has no lines", () => {
    expect(r.findings.find((x) => x.kind === "over_billed")?.qty).toBeNull();
  });

  it("also reports billed-not-received, because both are true at once", () => {
    // Goods worth £1,440 arrived; £1,560 was invoiced. The order was over-billed
    // AND £120 of it is for goods nobody has. Collapsing the two into one label
    // would lose a fact a buyer needs on the phone to the merchant.
    expect(r.findings.map((f) => f.kind)).toEqual(["over_billed", "billed_not_received"]);
    expect(r.findings[1]?.gross).toBe(120);
  });

  it("ranks over_billed as the headline of the two", () => {
    expect(MATCH_STATE_RANK.over_billed).toBeGreaterThan(MATCH_STATE_RANK.billed_not_received);
    expect(r.worstVariance).toBe(120);
  });

  it("counts the SAME £120 once in moneyOutAtRisk, not twice", () => {
    // The two findings are the same pounds from two angles. £120 is what the
    // company has been asked for and may not owe; £240 is a number that does
    // not exist anywhere, and would be the figure if a roll-up added the kinds.
    expect(r.moneyOutAtRisk).toBe(120);
    const naiveSum = r.findings.reduce((t, f) => t + f.gross, 0);
    expect(naiveSum).toBe(240);
    expect(r.moneyOutAtRisk).not.toBe(naiveSum);
  });
});

describe("moneyOutAtRisk — the one figure that may be summed across orders", () => {
  it("is billed minus the LESSER of committed and received", () => {
    // Ordered £1,440, only £480 arrived, £1,560 invoiced: £1,080 of the invoice
    // has nothing behind it (of which £120 is also above the order).
    const r = match({
      grns: [grn("g1", "posted", [["l1", 4]])],
      bills: [bill("b1", 1300, 260)],
    });
    expect(r.received.gross).toBe(480);
    expect(r.billedVsOrdered).toBe(120);
    expect(r.billedVsReceived).toBe(1080);
    expect(r.moneyOutAtRisk).toBe(1080);
  });

  it("is the whole bill on a cancelled order — nothing justifies any of it", () => {
    const r = match({ bills: [bill("b1", ORDER_NET, ORDER_VAT)], cancelled: true });
    expect(r.moneyOutAtRisk).toBe(1440);
  });

  it("EXCLUDES the accrual — an unbilled delivery is not money out", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])] });
    expect(r.accrual).toBe(1440);
    expect(r.state).toBe("received_not_billed");
    expect(r.moneyOutAtRisk).toBe(0);
  });

  it("is zero for open, matched and part-billed orders", () => {
    expect(match({}).moneyOutAtRisk).toBe(0);
    expect(
      match({
        grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
        bills: [bill("b1", ORDER_NET, ORDER_VAT)],
      }).moneyOutAtRisk,
    ).toBe(0);
    expect(
      match({ grns: [grn("g1", "posted", [["l1", 10]])], bills: [bill("b1", 1000, 200)] })
        .moneyOutAtRisk,
    ).toBe(0);
  });
});

describe("state: billed_not_received — invoiced for goods that never arrived", () => {
  const r = match({ bills: [bill("b1", ORDER_NET, ORDER_VAT)] });

  it("flags the full invoice when nothing has been delivered", () => {
    expect(r.state).toBe("billed_not_received");
    expect(r.billedVsOrdered).toBe(0); // the ORDER was billed correctly
    expect(r.billedVsReceived).toBe(1440);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.gross).toBe(1440);
    expect(r.findings[0]?.net).toBe(1200);
  });

  it("states the quantity that has NOT arrived", () => {
    expect(r.findings[0]?.qty).toBe(14); // 10 blocks + 4 sand
  });

  it("is a discrepancy even though ordered and billed agree exactly", () => {
    // The trap this closes: computePoBilling alone reads this order as "fully
    // billed" and green. Two legs agreeing is not a match.
    expect(r.isDiscrepancy).toBe(true);
  });
});

describe("state: received_not_billed — the accrual", () => {
  it("flags goods on site with no bill against them", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])] });
    expect(r.state).toBe("received_not_billed");
    expect(r.accrual).toBe(1440);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toEqual({
      kind: "received_not_billed",
      gross: 1440,
      net: 1200,
      qty: 14,
    });
  });

  it("flags a PARTIAL delivery that is unbilled too — the cost is still real", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 6]])] });
    expect(r.received.gross).toBe(720); // 6 × £100 + VAT
    expect(r.state).toBe("received_not_billed");
    expect(r.accrual).toBe(720);
    expect(r.findings[0]?.qty).toBe(6);
    expect(r.receiptStatus).toBe("partial");
  });

  it("reports the NET accrual too — that is the figure missing from job cost", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])] });
    expect(r.findings[0]?.net).toBe(1200); // VAT is reclaimable; cost is net
  });

  it("exposes the earliest posted delivery date so a human can judge the age", () => {
    // Deliberately NOT an age in days and NOT a cutoff: see the module header.
    const r = match({
      grns: [
        grn("g2", "posted", [["l2", 4]], "2026-06-20"),
        grn("g1", "posted", [["l1", 10]], "2026-05-04"),
      ],
    });
    expect(r.earliestPostedReceiptDate).toBe("2026-05-04");
  });
});

describe("state: part_billed — behind, but consistent", () => {
  it("is not a discrepancy when the bill matches what has arrived", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10]])], // £1,200 gross of goods
      bills: [bill("b1", 1000, 200)], // £1,200 gross billed
    });
    expect(r.state).toBe("part_billed");
    expect(r.isDiscrepancy).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.billedVsOrdered).toBe(-240); // £240 of the order still to come
    expect(r.billedVsReceived).toBe(0);
    expect(r.accrual).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Partial deliveries across MULTIPLE goods received notes
// ---------------------------------------------------------------------------

describe("partial deliveries across multiple GRNs", () => {
  it("sums the same ordered line across several posted notes", () => {
    const r = match({
      grns: [
        grn("g1", "posted", [["l1", 4]]),
        grn("g2", "posted", [["l1", 6]]),
      ],
    });
    expect(r.lines[0]?.receivedQty).toBe(10);
    expect(r.lines[0]?.qtyVariance).toBe(0);
    expect(r.received.gross).toBe(1200);
    expect(r.postedGrnCount).toBe(2);
  });

  it("is only 'full' when EVERY line is satisfied, not when the total adds up", () => {
    // 14 units arrived in total — but all of them against line 1, which only
    // ordered 10. A total that happens to add up is not a complete delivery.
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10]]), grn("g2", "posted", [["l1", 4]])],
    });
    expect(r.lines[0]?.receivedQty).toBe(14);
    expect(r.lines[1]?.receivedQty).toBe(0);
    expect(r.receiptStatus).toBe("partial");
    expect(r.hasOverReceipt).toBe(true);
    expect(r.lines[0]?.overReceived).toBe(true);
    expect(r.lines[1]?.overReceived).toBe(false);
  });

  it("reports per-line quantity variance in ordered units", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 7], ["l2", 4]])] });
    expect(r.lines[0]?.qtyVariance).toBe(3); // 3 blocks outstanding
    expect(r.lines[1]?.qtyVariance).toBe(0);
    expect(r.lines[0]?.unit).toBe("ea");
  });

  it("values a three-way partial correctly against a partial bill", () => {
    // 7 blocks (£840 gross) + 4 sand (£240 gross) = £1,080 in. £600 billed.
    const r = match({
      grns: [grn("g1", "posted", [["l1", 4]]), grn("g2", "posted", [["l1", 3], ["l2", 4]])],
      bills: [bill("b1", 500, 100)],
    });
    expect(r.received.gross).toBe(1080);
    expect(r.billed.gross).toBe(600);
    expect(r.accrual).toBe(480);
    expect(r.state).toBe("received_not_billed");
  });
});

// ---------------------------------------------------------------------------
// 4. VOIDED and DRAFT notes must not count as received
// ---------------------------------------------------------------------------

describe("voided goods received notes", () => {
  it("a voided note contributes NOTHING to the received leg", () => {
    const r = match({ grns: [grn("g1", "void", [["l1", 10], ["l2", 4]])] });
    expect(r.received.gross).toBe(0);
    expect(r.receiptStatus).toBe("none");
    expect(r.voidedGrnCount).toBe(1);
    expect(r.postedGrnCount).toBe(0);
    expect(r.state).toBe("open");
  });

  it("voiding a receipt walks the accrual back to zero", () => {
    const before = match({ grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])] });
    expect(before.accrual).toBe(1440);
    const after = match({ grns: [grn("g1", "void", [["l1", 10], ["l2", 4]])] });
    expect(after.accrual).toBe(0);
  });

  it("a voided note cannot turn a billed order into a match", () => {
    // THE trap: the delivery was voided, so the goods are not ours — but the
    // supplier's invoice still stands. Counting the void as received would
    // report "matched" on an order we are being invoiced for and have nothing
    // to show for.
    const r = match({
      grns: [grn("g1", "void", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", ORDER_NET, ORDER_VAT)],
    });
    expect(r.state).toBe("billed_not_received");
    expect(r.findings[0]?.gross).toBe(1440);
  });

  it("counts only the posted notes when a void sits alongside them", () => {
    const r = match({
      grns: [
        grn("g1", "posted", [["l1", 10]]),
        grn("g2", "void", [["l2", 4]]),
        grn("g3", "draft", [["l2", 4]]),
      ],
    });
    expect(r.received.gross).toBe(1200);
    expect(r.postedGrnCount).toBe(1);
    expect(r.voidedGrnCount).toBe(1);
    expect(r.draftGrnCount).toBe(1);
    expect(r.lines[1]?.receivedQty).toBe(0);
  });

  it("ignores the earliest VOID date when reporting the earliest posted receipt", () => {
    const r = match({
      grns: [
        grn("g1", "void", [["l1", 10]], "2026-01-01"),
        grn("g2", "posted", [["l1", 10]], "2026-07-07"),
      ],
    });
    expect(r.earliestPostedReceiptDate).toBe("2026-07-07");
  });
});

describe("draft goods received notes", () => {
  it("a draft has not happened yet and contributes nothing", () => {
    const r = match({ grns: [grn("g1", "draft", [["l1", 10], ["l2", 4]])] });
    expect(r.received.gross).toBe(0);
    expect(r.draftGrnCount).toBe(1);
    expect(r.receiptStatus).toBe("none");
    expect(r.state).toBe("open");
  });

  it("an unknown status is treated as NOT received (fail closed)", () => {
    const r = match({ grns: [grn("g1", "something_new", [["l1", 10]])] });
    expect(r.received.gross).toBe(0);
    expect(r.postedGrnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Bills with no PO link, and bills belonging to another order
// ---------------------------------------------------------------------------

describe("bills that do not reference this order", () => {
  it("a bill with NO purchase_order_id is excluded from the billed leg", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", ORDER_NET, ORDER_VAT, null)],
    });
    expect(r.billed.gross).toBe(0);
    expect(r.billCount).toBe(0);
    expect(r.unlinkedBillCount).toBe(1);
    // ...and the order therefore still reads as an unbilled accrual, which is
    // the truth: nothing has been billed AGAINST THIS ORDER.
    expect(r.state).toBe("received_not_billed");
    expect(r.accrual).toBe(1440);
  });

  it("a bill on a DIFFERENT order cannot inflate this order's billed leg", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", 5000, 1000, "some-other-po")],
    });
    expect(r.billed.gross).toBe(0);
    expect(r.foreignBillCount).toBe(1);
    expect(r.unlinkedBillCount).toBe(0);
    expect(r.state).toBe("received_not_billed");
  });

  it("counts linked, unlinked and foreign bills separately in one pass", () => {
    const r = match({
      bills: [
        bill("b1", 100, 20),
        bill("b2", 100, 20, null),
        bill("b3", 100, 20, "other"),
        bill("b4", 100, 20),
      ],
    });
    expect(r.billCount).toBe(2);
    expect(r.unlinkedBillCount).toBe(1);
    expect(r.foreignBillCount).toBe(1);
    expect(r.billed).toEqual({ net: 200, vat: 40, gross: 240 });
  });

  it("treats an undefined purchase_order_id the same as null", () => {
    const r = match({ bills: [{ id: "b1", amount: 100, vat_total: 20 }] });
    expect(r.unlinkedBillCount).toBe(1);
    expect(r.billed.gross).toBe(0);
  });
});

describe("supplier credit notes", () => {
  it("a negative bill reduces what has been billed, and can clear an over-billing", () => {
    // `finances.amount` has no positivity constraint, and a merchant's credit
    // note against an over-charged order is normal practice. It must net off
    // rather than be ignored or double-counted.
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", 1300, 260), bill("credit", -100, -20)],
    });
    expect(r.billed).toEqual({ net: 1200, vat: 240, gross: 1440 });
    expect(r.state).toBe("matched");
    expect(r.billCount).toBe(2);
  });

  it("an over-credit leaves the order looking under-billed, not matched", () => {
    const r = match({
      grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
      bills: [bill("b1", 1200, 240), bill("credit", -500, -100)],
    });
    expect(r.billed.gross).toBe(840);
    expect(r.accrual).toBe(600);
    expect(r.state).toBe("received_not_billed");
  });
});

describe("orders with no bill at all", () => {
  it("an open order with no receipts and no bills produces no findings", () => {
    const r = match({ bills: [] });
    expect(r.billCount).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.state).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// 6. Rounding at numeric(12,2)
// ---------------------------------------------------------------------------

describe("rounding at numeric(12,2)", () => {
  const DECIMAL: MatchOrderedLine[] = [
    // 12.5 m³ of concrete at £33.33 — the qty column is numeric(12,2), so a
    // decimal unit is normal, not exotic.
    { id: "l1", description: "C25 concrete", unit: "m3", qty: 12.5, unit_price: 33.33, vat_rate: 20 },
  ];

  it("values a decimal quantity with per-line VAT, no float drift", () => {
    const r = matchThreeWay({ poId: PO, lines: DECIMAL, grns: [], bills: [] });
    expect(r.ordered).toEqual({ net: 416.63, vat: 83.33, gross: 499.96 });
  });

  it("a half delivery of a decimal quantity accrues to the penny", () => {
    const r = matchThreeWay({
      poId: PO,
      lines: DECIMAL,
      grns: [grn("g1", "posted", [["l1", 6.25]])],
      bills: [],
    });
    expect(r.received).toEqual({ net: 208.31, vat: 41.66, gross: 249.97 });
    expect(r.accrual).toBe(249.97);
    expect(r.lines[0]?.qtyVariance).toBe(6.25);
  });

  it("three 33.33/33.34-style bills summing to the order read as matched", () => {
    const lines: MatchOrderedLine[] = [
      { id: "l1", description: "Sundries", unit: "ea", qty: 1, unit_price: 100, vat_rate: 0 },
    ];
    const r = matchThreeWay({
      poId: PO,
      lines,
      grns: [grn("g1", "posted", [["l1", 1]])],
      bills: [bill("b1", 33.33, 0), bill("b2", 33.33, 0), bill("b3", 33.34, 0)],
    });
    expect(r.billed.gross).toBe(100);
    expect(r.state).toBe("matched");
  });

  it("coerces numeric strings and nulls the way Postgres hands them over", () => {
    const r = matchThreeWay({
      poId: PO,
      lines: [
        { id: "l1", description: "Blocks", unit: null, qty: "10.00", unit_price: "100.00", vat_rate: "20.00" },
        { id: "l2", description: "Nothing", unit: "", qty: null, unit_price: null, vat_rate: null },
      ],
      grns: [{ id: "g", number: "GRN-1", status: "posted", delivery_date: null, lines: [{ purchase_order_line_item_id: "l1", qty_received: "4.00" }] }],
      bills: [{ id: "b", purchase_order_id: PO, amount: "400.00", vat_total: null }],
    });
    expect(r.ordered.gross).toBe(1200);
    expect(r.received.gross).toBe(480);
    expect(r.billed).toEqual({ net: 400, vat: 0, gross: 400 });
    expect(r.accrual).toBe(80);
    expect(r.lines[1]?.unit).toBe("ea");
    expect(r.earliestPostedReceiptDate).toBeNull();
  });

  it("never divides by zero on a £0 order", () => {
    const r = matchThreeWay({
      poId: PO,
      lines: [{ id: "l1", description: "Free issue", unit: "ea", qty: 5, unit_price: 0, vat_rate: 0 }],
      grns: [grn("g1", "posted", [["l1", 5]])],
      bills: [],
    });
    expect(r.ordered.gross).toBe(0);
    expect(r.received.gross).toBe(0);
    expect(r.state).toBe("matched"); // received in full, nothing to bill
    expect(r.findings).toEqual([]);
  });

  it("a £0 order that has NOT been delivered is still open", () => {
    // "Open" is about events, not money — so a nil-value order flips from open
    // to matched when the delivery is posted, exactly like a priced one.
    const r = matchThreeWay({
      poId: PO,
      lines: [{ id: "l1", description: "Free issue", unit: "ea", qty: 5, unit_price: 0, vat_rate: 0 }],
      grns: [grn("g1", "draft", [["l1", 5]])],
      bills: [],
    });
    expect(r.state).toBe("open");
  });

  it("handles an order with no lines at all", () => {
    const r = matchThreeWay({ poId: PO, lines: [], grns: [], bills: [bill("b1", 100, 20)] });
    expect(r.ordered.gross).toBe(0);
    expect(r.lines).toEqual([]);
    expect(r.state).toBe("over_billed");
    expect(r.billedVsOrdered).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 7. NO TOLERANCE POLICY — every penny is flagged, and a threshold can be
//    introduced later without reshaping a single caller
// ---------------------------------------------------------------------------

describe("no tolerance policy", () => {
  const pennyOver = {
    grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
    bills: [bill("b1", 1200.01, 240)], // £1,440.01 gross — ONE penny over
  };

  it("the default policy is ZERO — a single penny is a flagged variance", () => {
    expect(NO_TOLERANCE_POLICY.minMoneyVariance).toBe(0);
    const r = match(pennyOver);
    expect(r.billedVsOrdered).toBe(0.01);
    expect(r.state).toBe("over_billed");
    expect(r.findings.find((f) => f.kind === "over_billed")?.gross).toBe(0.01);
  });

  it("a caller that passes no policy gets the zero-tolerance default", () => {
    const explicit = matchThreeWay({ poId: PO, ...pennyOver, lines: LINES }, NO_TOLERANCE_POLICY);
    const implicit = matchThreeWay({ poId: PO, ...pennyOver, lines: LINES });
    expect(implicit).toEqual(explicit);
  });

  it("a threshold introduced later suppresses the finding without changing any call shape", () => {
    // This is the ONLY test that passes a non-zero threshold, and it exists to
    // prove the seam works — NOT to propose a value. What counts as acceptable
    // is a CEO decision that has not been taken.
    const r = matchThreeWay({ poId: PO, lines: LINES, ...pennyOver }, { minMoneyVariance: 2 });
    expect(r.billedVsOrdered).toBe(0.01); // the exact number is STILL reported
    expect(r.findings).toEqual([]); // it is simply not flagged
    expect(r.state).toBe("matched");
  });

  it("a variance above a hypothetical threshold is still flagged with its exact size", () => {
    const r = matchThreeWay(
      {
        poId: PO,
        lines: LINES,
        grns: [grn("g1", "posted", [["l1", 10], ["l2", 4]])],
        bills: [bill("b1", 1202.01, 240)], // £2.01 over
      },
      { minMoneyVariance: 2 },
    );
    expect(r.state).toBe("over_billed");
    expect(r.findings[0]?.gross).toBe(2.01);
  });

  it("the float-noise floor cannot be lowered below half a penny by a policy of 0", () => {
    // A variance smaller than 1p cannot exist in numeric(12,2); the floor only
    // ever absorbs float noise, never a real difference.
    const r = matchThreeWay(
      {
        poId: PO,
        lines: [{ id: "l1", description: "x", unit: "ea", qty: 1, unit_price: 100, vat_rate: 0 }],
        grns: [grn("g1", "posted", [["l1", 1]])],
        bills: [{ id: "b", purchase_order_id: PO, amount: 100.001, vat_total: 0 }],
      },
      { minMoneyVariance: 0 },
    );
    expect(r.findings).toEqual([]);
    expect(r.state).toBe("matched");
  });
});

// ---------------------------------------------------------------------------
// 8. A cancelled order commits nothing
// ---------------------------------------------------------------------------

describe("cancelled orders", () => {
  it("a bill against a cancelled order is over-billed by its WHOLE value", () => {
    // computeCommittedCosts already excludes cancelled orders from committed
    // spend; applying the same definition here is what stops a cancelled-and-
    // billed order reading as a perfect match.
    const r = match({ bills: [bill("b1", ORDER_NET, ORDER_VAT)], cancelled: true });
    expect(r.committedGross).toBe(0);
    expect(r.ordered.gross).toBe(ORDER_GROSS); // the paperwork is still reported
    expect(r.state).toBe("over_billed");
    expect(r.findings.find((f) => f.kind === "over_billed")?.gross).toBe(1440);
  });

  it("a cancelled order with nothing against it is quiet", () => {
    const r = match({ cancelled: true });
    expect(r.state).toBe("open");
    expect(r.findings).toEqual([]);
  });

  it("goods that actually arrived before the cancellation are still received", () => {
    const r = match({ grns: [grn("g1", "posted", [["l1", 10]])], cancelled: true });
    expect(r.received.gross).toBe(1200);
    expect(r.state).toBe("received_not_billed");
    expect(r.accrual).toBe(1200);
  });

  it("committedGross equals ordered.gross for every non-cancelled order", () => {
    expect(match({}).committedGross).toBe(ORDER_GROSS);
    expect(match({ cancelled: false }).committedGross).toBe(ORDER_GROSS);
  });
});

// ---------------------------------------------------------------------------
// 9. Determinism, ordering and presentation
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the same input produces an identical result every time", () => {
    const input = {
      poId: PO,
      lines: LINES,
      grns: [grn("g1", "posted", [["l1", 4]]), grn("g2", "posted", [["l1", 3], ["l2", 1]])],
      bills: [bill("b1", 500, 100), bill("b2", 25, 5, null)],
    };
    expect(matchThreeWay(input)).toEqual(matchThreeWay(input));
  });

  it("GRN order in the input does not change the answer", () => {
    const a = match({ grns: [grn("g1", "posted", [["l1", 4]]), grn("g2", "posted", [["l1", 6]])] });
    const b = match({ grns: [grn("g2", "posted", [["l1", 6]]), grn("g1", "posted", [["l1", 4]])] });
    expect(a.received).toEqual(b.received);
    expect(a.state).toBe(b.state);
  });
});

describe("compareMatchSeverity", () => {
  const row = (state: string, worstVariance: number, number: string) => ({
    number,
    match: { state, worstVariance } as unknown as ThreeWayMatch,
  });

  it("puts the worst state first, then the biggest money, then the PO number", () => {
    const rows = [
      row("received_not_billed", 9000, "PO-0004"),
      row("over_billed", 10, "PO-0003"),
      row("billed_not_received", 500, "PO-0002"),
      row("over_billed", 10, "PO-0001"),
      row("over_billed", 250, "PO-0005"),
    ];
    expect([...rows].sort(compareMatchSeverity).map((r) => r.number)).toEqual([
      "PO-0005", // over_billed, £250
      "PO-0001", // over_billed, £10 — number breaks the tie
      "PO-0003", // over_billed, £10
      "PO-0002", // billed_not_received
      "PO-0004", // received_not_billed — biggest money, lowest severity
    ]);
  });

  it("is a TOTAL order — the PO number tiebreak is unique per org", () => {
    // purchase_orders_org_number_key makes `number` unique within an org, so a
    // paged read using this comparator can never drop or repeat a row.
    const a = row("over_billed", 100, "PO-0001");
    const b = row("over_billed", 100, "PO-0002");
    expect(compareMatchSeverity(a, b)).toBeLessThan(0);
    expect(compareMatchSeverity(b, a)).toBeGreaterThan(0);
    expect(compareMatchSeverity(a, a)).toBe(0);
  });
});

describe("presentation helpers", () => {
  const money = (n: number) => `£${n.toFixed(2)}`;

  it("labels every state", () => {
    for (const key of Object.keys(MATCH_STATE_RANK)) {
      expect(MATCH_STATE_LABEL[key as keyof typeof MATCH_STATE_LABEL]).toBeTruthy();
    }
  });

  it("describes every finding kind with its number in the sentence", () => {
    for (const kind of ["over_billed", "billed_not_received", "received_not_billed"] as const) {
      const s = describeFinding({ kind, gross: 120.5, net: 100, qty: null }, money);
      expect(s).toContain("£120.50");
      expect(s.endsWith(".")).toBe(true);
    }
  });

  it("never tells the reader a variance is acceptable", () => {
    for (const kind of ["over_billed", "billed_not_received", "received_not_billed"] as const) {
      const s = describeFinding({ kind, gross: 1, net: 1, qty: null }, money).toLowerCase();
      for (const word of ["acceptable", "tolerance", "ignore", "small", "negligible", "fine"]) {
        expect(s, `${kind} must not editorialise`).not.toContain(word);
      }
    }
  });
});
