import { describe, expect, it } from "vitest";
import {
  computeJobCommercialPosition,
  hasCommercialPosition,
} from "@/lib/jobs/commercial-position";
import { formatGbp, round2, sumMoney, toPounds } from "@/lib/money";

describe("money helpers", () => {
  it("coerces, rounds and sums without float drift", () => {
    expect(toPounds("2400.5")).toBe(2400.5);
    expect(toPounds(null)).toBe(0);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(sumMoney([0.1, 0.2, "0.1", null])).toBe(0.4);
    expect(formatGbp(2400)).toBe("£2,400.00");
  });
});

describe("computeJobCommercialPosition", () => {
  it("preserves the original and DERIVES the revised value from approved variations", () => {
    const p = computeJobCommercialPosition({
      quotes: [
        { status: "accepted", total: 12000, variation_number: null }, // base contract
        { status: "accepted", total: 2400, variation_number: 1 }, // approved variation
        { status: "accepted", total: 600, variation_number: 2 }, // approved variation
        { status: "sent", total: 1500, variation_number: 3 }, // pending — NOT in revised
        { status: "declined", total: 999, variation_number: 4 }, // ignored
      ],
      invoices: [
        { status: "paid", total: 12000 },
        { status: "sent", total: 3000 },
        { status: "draft", total: 500 }, // not raised
      ],
    });
    expect(p.original).toBe(12000);
    expect(p.approvedVariations).toBe(3000);
    expect(p.revised).toBe(15000); // original + approved, NOT pending
    expect(p.pendingVariations).toBe(1500);
    expect(p.invoiced).toBe(15000); // 12000 paid + 3000 sent; draft excluded
    expect(p.paid).toBe(12000);
    expect(p.uninvoiced).toBe(0); // 15000 revised − 15000 invoiced
    expect(p.outstanding).toBe(3000); // 15000 invoiced − 12000 paid
    expect(p.counts).toEqual({ approvedVariations: 2, pendingVariations: 1 });
  });

  it("is all-zero for a job with nothing accepted/invoiced", () => {
    const p = computeJobCommercialPosition({
      quotes: [{ status: "draft", total: 5000, variation_number: null }],
      invoices: [],
    });
    expect(p.revised).toBe(0);
    expect(hasCommercialPosition(p)).toBe(false);
  });

  it("surfaces the panel once anything commercial exists", () => {
    const p = computeJobCommercialPosition({
      quotes: [{ status: "accepted", total: 8000, variation_number: null }],
      invoices: [],
    });
    expect(hasCommercialPosition(p)).toBe(true);
    expect(p.uninvoiced).toBe(8000);
  });
});
