import { describe, expect, it } from "vitest";
import {
  computeReceiving,
  formatQty,
  PO_RECEIPT_STATUS_LABEL,
  type ReceivingOrderedLine,
} from "@/lib/purchase-orders/receiving";

/**
 * Warehouse M1 — the receiving arithmetic (lib/purchase-orders/receiving.ts).
 *
 * This is the model the yard form renders and the number the owner reads, so
 * the cases below are the ones that would produce a WRONG answer on site:
 * part deliveries, decimal units, several notes against one line, and every
 * flavour of bad input the form can be handed.
 */

const LINES: ReceivingOrderedLine[] = [
  { id: "line-a", description: "Blocks", unit: "ea", qty: 100 },
  { id: "line-b", description: "Concrete", unit: "m3", qty: 12.5 },
];

describe("computeReceiving", () => {
  it("reports 'none' and full remaining when nothing has been received", () => {
    const r = computeReceiving({ lines: LINES, receipts: [] });
    expect(r.status).toBe("none");
    expect(r.totalOrdered).toBe(112.5);
    expect(r.totalPreviouslyReceived).toBe(0);
    expect(r.totalRemaining).toBe(112.5);
    expect(r.pct).toBe(0);
    expect(r.lines[0]?.remaining).toBe(100);
    expect(r.lines[1]?.remaining).toBe(12.5);
    expect(PO_RECEIPT_STATUS_LABEL[r.status]).toBe("Not received");
  });

  it("PARTIAL: 40 of 100 on one line leaves 60 outstanding on that line", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [{ purchase_order_line_item_id: "line-a", qty_received: 40 }],
    });
    expect(r.status).toBe("partial");
    expect(r.lines[0]?.previouslyReceived).toBe(40);
    expect(r.lines[0]?.remaining).toBe(60);
    expect(r.lines[0]?.complete).toBe(false);
    expect(r.totalRemaining).toBe(72.5); // 60 + 12.5
  });

  it("is PARTIAL when one line is complete but another has had nothing", () => {
    // The trap: a total-only comparison would call this 'full' as soon as the
    // numbers happened to add up. Every LINE must be satisfied.
    const r = computeReceiving({
      lines: LINES,
      receipts: [{ purchase_order_line_item_id: "line-a", qty_received: 100 }],
    });
    expect(r.status).toBe("partial");
    expect(r.lines[0]?.complete).toBe(true);
    expect(r.lines[1]?.complete).toBe(false);
  });

  it("FULL only when every ordered line is satisfied", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [
        { purchase_order_line_item_id: "line-a", qty_received: 100 },
        { purchase_order_line_item_id: "line-b", qty_received: 12.5 },
      ],
    });
    expect(r.status).toBe("full");
    expect(r.totalRemaining).toBe(0);
    expect(r.pct).toBe(100);
    expect(r.lines.every((l) => l.complete)).toBe(true);
  });

  it("DUPLICATE receipt rows for one line are SUMMED (several notes, one line)", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [
        { purchase_order_line_item_id: "line-a", qty_received: 40 },
        { purchase_order_line_item_id: "line-a", qty_received: 35 },
        { purchase_order_line_item_id: "line-a", qty_received: 25 },
      ],
    });
    expect(r.lines[0]?.previouslyReceived).toBe(100);
    expect(r.lines[0]?.complete).toBe(true);
    expect(r.lines[0]?.remaining).toBe(0);
  });

  it("ROUNDING: decimal units sum to 2dp without float drift", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754; the money discipline fixes it.
    const r = computeReceiving({
      lines: [{ id: "l", description: "Ballast", unit: "t", qty: 3 }],
      receipts: [
        { purchase_order_line_item_id: "l", qty_received: "0.10" },
        { purchase_order_line_item_id: "l", qty_received: "0.20" },
      ],
    });
    expect(r.lines[0]?.previouslyReceived).toBe(0.3);
    expect(r.lines[0]?.remaining).toBe(2.7);
  });

  it("treats a line as complete within the 0.005 tolerance, not exactly", () => {
    const r = computeReceiving({
      lines: [{ id: "l", description: "Sand", unit: "t", qty: 2.75 }],
      receipts: [{ purchase_order_line_item_id: "l", qty_received: 2.749 }],
    });
    expect(r.lines[0]?.complete).toBe(true);
    expect(r.status).toBe("full");
  });

  // ── the entry side (what the operator is typing right now) ────────────────
  it("OVER: entering more than is outstanding flags the line and the form", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [{ purchase_order_line_item_id: "line-a", qty_received: 40 }],
      receivingNow: { "line-a": 61 },
    });
    expect(r.lines[0]?.over).toBe(true);
    expect(r.lines[0]?.receivedAfter).toBe(101);
    expect(r.hasOverReceipt).toBe(true);
  });

  it("receiving EXACTLY the outstanding quantity is not an over-receipt", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [{ purchase_order_line_item_id: "line-a", qty_received: 40 }],
      receivingNow: { "line-a": 60 },
    });
    expect(r.lines[0]?.over).toBe(false);
    expect(r.lines[0]?.complete).toBe(true);
    expect(r.lines[0]?.outstanding).toBe(0);
    expect(r.count).toBe(1);
  });

  it("ZERO / blank entries are simply not received (and not an error)", () => {
    const r = computeReceiving({
      lines: LINES,
      receipts: [],
      receivingNow: { "line-a": 0, "line-b": "" },
    });
    expect(r.count).toBe(0);
    expect(r.totalReceivingNow).toBe(0);
    expect(r.hasInvalidEntry).toBe(false);
  });

  it("NEGATIVE and non-numeric entries are rejected, never silently used", () => {
    // The DB CHECK is qty_received > 0; a negative "return" must not sneak
    // through as a receipt, and 'abc' must not become NaN arithmetic.
    const neg = computeReceiving({
      lines: LINES,
      receipts: [],
      receivingNow: { "line-a": -5 },
    });
    expect(neg.hasInvalidEntry).toBe(true);
    expect(neg.lines[0]?.receivingNow).toBe(0);
    expect(neg.totalReceivingNow).toBe(0);

    const nan = computeReceiving({
      lines: LINES,
      receipts: [],
      receivingNow: { "line-a": "abc" },
    });
    expect(nan.hasInvalidEntry).toBe(true);
    expect(nan.lines[0]?.receivingNow).toBe(0);
  });

  it("never reports a negative remaining, even after an over-receipt", () => {
    const r = computeReceiving({
      lines: [{ id: "l", description: "Pipe", unit: "m", qty: 10 }],
      receipts: [{ purchase_order_line_item_id: "l", qty_received: 14 }],
    });
    expect(r.lines[0]?.remaining).toBe(0);
    expect(r.totalRemaining).toBe(0);
    expect(r.status).toBe("full");
  });

  it("handles an order with no lines without dividing by zero", () => {
    const r = computeReceiving({ lines: [], receipts: [] });
    expect(r.status).toBe("none");
    expect(r.pct).toBe(0);
    expect(r.totalOrdered).toBe(0);
  });

  it("ignores receipts for lines that are no longer on the order", () => {
    // po_receipt_state() in 20261060000000 is defined the same way (it joins
    // through purchase_order_line_items), so the page and the stored status
    // cannot disagree. A receipt against a line that is not on the order is
    // structurally impossible anyway — tg_goods_received_line_draft_only
    // refuses it — but the two definitions are kept identical on purpose.
    const r = computeReceiving({
      lines: [{ id: "l", description: "Pipe", unit: "m", qty: 10 }],
      receipts: [{ purchase_order_line_item_id: "gone", qty_received: 99 }],
    });
    expect(r.lines[0]?.previouslyReceived).toBe(0);
    expect(r.totalPreviouslyReceived).toBe(0);
    expect(r.status).toBe("none");
  });

  it("defaults a missing unit to 'ea' so the yard never sees a blank", () => {
    const r = computeReceiving({
      lines: [{ id: "l", description: "Bolts", unit: null, qty: 50 }],
      receipts: [],
    });
    expect(r.lines[0]?.unit).toBe("ea");
  });
});

describe("formatQty", () => {
  it("drops the decimals on whole quantities and keeps 2dp otherwise", () => {
    expect(formatQty(100)).toBe("100");
    expect(formatQty("100.00")).toBe("100");
    expect(formatQty(12.5)).toBe("12.50");
    expect(formatQty(2.755)).toBe("2.76");
    expect(formatQty(null)).toBe("0");
  });
});
