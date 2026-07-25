import { describe, expect, it } from "vitest";
import { computePoBilling, PO_BILL_STATUS_LABEL } from "@/lib/purchase-orders/billing";

/**
 * Supplier-bill roll-up (committed PO vs actual billed). A PO of £1,200 gross =
 * £1,000 net + £200 VAT.
 */
describe("computePoBilling", () => {
  const po = 1200; // gross

  it("is UNBILLED with no bills — remaining equals the whole PO", () => {
    const r = computePoBilling({ poTotal: po, bills: [] });
    expect(r.status).toBe("unbilled");
    expect(r.billedGross).toBe(0);
    expect(r.billedNet).toBe(0);
    expect(r.remaining).toBe(1200);
    expect(r.pct).toBe(0);
    expect(r.count).toBe(0);
  });

  it("is PART_BILLED when the bills so far are under the PO total", () => {
    const r = computePoBilling({
      poTotal: po,
      bills: [{ amount: 500, vat_total: 100 }], // £600 gross
    });
    expect(r.status).toBe("part_billed");
    expect(r.billedNet).toBe(500);
    expect(r.billedGross).toBe(600);
    expect(r.remaining).toBe(600);
    expect(r.pct).toBe(50);
  });

  it("is FULLY_BILLED when the bills sum to the PO total (across multiple bills)", () => {
    const r = computePoBilling({
      poTotal: po,
      bills: [
        { amount: 500, vat_total: 100 }, // 600
        { amount: 500, vat_total: 100 }, // 600
      ],
    });
    expect(r.status).toBe("fully_billed");
    expect(r.billedGross).toBe(1200);
    expect(r.remaining).toBe(0);
    expect(r.pct).toBe(100);
  });

  it("is OVER_BILLED when the supplier invoices more than was ordered", () => {
    const r = computePoBilling({
      poTotal: po,
      bills: [{ amount: 1200, vat_total: 240 }], // £1,440 gross
    });
    expect(r.status).toBe("over_billed");
    expect(r.billedGross).toBe(1440);
    expect(r.remaining).toBe(-240); // negative = over
    expect(r.pct).toBe(120);
  });

  it("treats a penny of float noise as fully-billed, not over/under", () => {
    const r = computePoBilling({
      poTotal: 100.0,
      bills: [
        { amount: 33.33, vat_total: 0 },
        { amount: 33.33, vat_total: 0 },
        { amount: 33.34, vat_total: 0 },
      ],
    });
    expect(r.billedGross).toBe(100);
    expect(r.status).toBe("fully_billed");
  });

  it("coerces numeric-string / null money and never divides by zero", () => {
    const r = computePoBilling({
      poTotal: "0",
      bills: [{ amount: "0", vat_total: null }],
    });
    expect(r.pct).toBe(0);
    expect(r.billedGross).toBe(0);
    expect(PO_BILL_STATUS_LABEL[r.status]).toBeDefined();
  });
});
