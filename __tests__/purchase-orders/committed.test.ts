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
});
