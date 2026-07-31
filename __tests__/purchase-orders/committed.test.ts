import { describe, expect, it } from "vitest";
import { computeCommittedCosts, hasCommittedCosts } from "@/lib/purchase-orders/committed";

describe("computeCommittedCosts", () => {
  it("sums live POs and splits on-order vs received; excludes cancelled", () => {
    const p = computeCommittedCosts([
      { status: "draft", total: 500 },
      { status: "sent", total: 1200 },
      { status: "received", total: 800 },
      { status: "cancelled", total: 9999 }, // excluded
    ]);
    expect(p.onOrder).toBe(1700); // 500 + 1200
    expect(p.received).toBe(800);
    expect(p.committed).toBe(2500); // 1700 + 800, cancelled excluded
    expect(p.count).toBe(3);
    expect(hasCommittedCosts(p)).toBe(true);
  });

  it("is empty when there are no live POs", () => {
    const p = computeCommittedCosts([{ status: "cancelled", total: 100 }]);
    expect(p.committed).toBe(0);
    expect(p.count).toBe(0);
    expect(hasCommittedCosts(p)).toBe(false);
  });

  it("coerces numeric-string totals without drift", () => {
    const p = computeCommittedCosts([
      { status: "sent", total: "100.10" },
      { status: "sent", total: "0.20" },
    ]);
    expect(p.onOrder).toBe(100.3);
    expect(p.committed).toBe(100.3);
  });

  // ── Warehouse M1: part-received is its own bucket ─────────────────────────
  it("splits partially_received out of on-order and keeps the buckets disjoint", () => {
    const p = computeCommittedCosts([
      { status: "draft", total: 500 },
      { status: "sent", total: 1200 },
      { status: "partially_received", total: 300 },
      { status: "received", total: 800 },
      { status: "cancelled", total: 9999 },
    ]);
    expect(p.onOrder).toBe(1700); // draft + sent only
    expect(p.partiallyReceived).toBe(300);
    expect(p.received).toBe(800);
    // the three sub-buckets partition the committed total exactly
    expect(p.onOrder + p.partiallyReceived + p.received).toBe(p.committed);
    expect(p.committed).toBe(2800);
    expect(p.count).toBe(4);
  });

  it("counts a partially_received PO as LIVE (it was invisible before M1)", () => {
    const p = computeCommittedCosts([{ status: "partially_received", total: 250 }]);
    expect(p.committed).toBe(250);
    expect(p.count).toBe(1);
    expect(hasCommittedCosts(p)).toBe(true);
  });

  // ── The ex-VAT commitment, netted against bills (20261072) ────────────────

  it("leaves the GROSS figures exactly as they were when no subtotal is supplied", () => {
    // Every existing caller passes `status, total` only. The gross tile must not
    // move, and the net figures must read as UNKNOWN rather than as £0 — a
    // silent zero would forecast "nothing further to come" on a job with £50k
    // on order.
    const p = computeCommittedCosts([
      { status: "sent", total: 1200 },
      { status: "received", total: 800 },
    ]);
    expect(p.committed).toBe(2000);
    expect(p.committedNet).toBe(0);
    expect(p.remaining).toBe(0);
    expect(p.netUnknown).toBe(2);
  });

  it("uses the EX-VAT subtotal for the net figures, not the VAT-inclusive total", () => {
    // The bug this exists to stop: `total` is gross, `finances.amount` is net.
    // Adding a gross commitment to a net actual overstates by the VAT.
    const p = computeCommittedCosts([{ status: "sent", subtotal: 1000, total: 1200 }]);
    expect(p.committed).toBe(1200); // gross, unchanged
    expect(p.committedNet).toBe(1000); // net
    expect(p.remaining).toBe(1000); // nothing billed yet
    expect(p.netUnknown).toBe(0);
  });

  it("nets each PO against the bills ALREADY posted against it", () => {
    const p = computeCommittedCosts([
      { status: "received", subtotal: 1000, total: 1200, billed: 1000 }, // fully billed
      { status: "partially_received", subtotal: 2000, total: 2400, billed: 750 }, // part billed
      { status: "sent", subtotal: 500, total: 600, billed: 0 }, // nothing billed
      { status: "cancelled", subtotal: 9999, total: 9999, billed: 0 }, // excluded
    ]);
    expect(p.committedNet).toBe(3500); // 1000 + 2000 + 500
    expect(p.billedAgainst).toBe(1750); // 1000 + 750
    expect(p.remaining).toBe(1750); // 0 + 1250 + 500
    expect(p.count).toBe(3);
  });

  it("floors PER PO, so an over-billed order cannot hide another's commitment", () => {
    // The cash.ts per-invoice rule, for the same reason: netting on the TOTAL
    // would let £3,000 of over-billing on one order cancel out £2,000 genuinely
    // still to come on another, and the forecast would under-state by £2,000.
    const p = computeCommittedCosts([
      { status: "received", subtotal: 1000, total: 1200, billed: 4000 }, // over-billed
      { status: "sent", subtotal: 2000, total: 2400, billed: 0 },
    ]);
    expect(p.remaining).toBe(2000); // NOT 2000 − 3000 = −1000 → 0
    expect(p.billedAgainst).toBe(1000); // each bill capped at its own PO's net
  });

  it("credit notes reduce the billed figure, but can never push `remaining` above the order", () => {
    // A £100 credit on a fully-billed £1,000 order genuinely leaves £100 still to
    // come, and does. But if credits EXCEED the bills the per-PO sum goes
    // negative, and an unclamped subtraction would report more still to come than
    // was ever ordered.
    const credited = computeCommittedCosts([
      { status: "received", subtotal: 1000, total: 1200, billed: 900 },
    ]);
    expect(credited.remaining).toBe(100);

    const overCredited = computeCommittedCosts([
      { status: "received", subtotal: 1000, total: 1200, billed: -250 },
    ]);
    expect(overCredited.remaining).toBe(1000); // the ordered value, not 1250
    expect(overCredited.billedAgainst).toBe(0);
  });

  it("coerces numeric-string subtotals and bills without drift", () => {
    const p = computeCommittedCosts([
      { status: "sent", subtotal: "100.10", total: "120.12", billed: "0.10" },
      { status: "sent", subtotal: "0.20", total: "0.24" },
    ]);
    expect(p.committedNet).toBe(100.3);
    expect(p.remaining).toBe(100.2);
  });
});
