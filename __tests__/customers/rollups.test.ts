import { describe, it, expect } from "vitest";
import {
  computeCustomerRollups,
  sortTimelineDesc,
} from "@/lib/customers/rollups";

describe("computeCustomerRollups", () => {
  it("sums totals + payments + lifetime revenue from paid invoices", () => {
    const r = computeCustomerRollups(
      [
        { status: "sent", total: 1000 },
        { status: "paid", total: 500 },
        { status: "partially_paid", total: 800 },
      ],
      [
        { amount: 500 }, // covers the paid one
        { amount: 200 }, // partial against the 800
      ],
    );
    expect(r.totalInvoiced).toBe(2300);
    expect(r.totalPaid).toBe(700);
    expect(r.outstanding).toBe(1600);
    expect(r.lifetimeRevenue).toBe(500);
  });

  it("handles string-encoded numerics from Supabase", () => {
    const r = computeCustomerRollups(
      [{ status: "paid", total: "1234.56" }],
      [{ amount: "1234.56" }],
    );
    expect(r.totalInvoiced).toBe(1234.56);
    expect(r.totalPaid).toBe(1234.56);
    expect(r.outstanding).toBe(0);
  });

  it("clamps outstanding to 0 when overpaid", () => {
    const r = computeCustomerRollups(
      [{ status: "paid", total: 100 }],
      [{ amount: 250 }],
    );
    expect(r.outstanding).toBe(0);
  });

  it("returns zeros for an empty customer", () => {
    const r = computeCustomerRollups([], []);
    expect(r.totalInvoiced).toBe(0);
    expect(r.totalPaid).toBe(0);
    expect(r.outstanding).toBe(0);
    expect(r.lifetimeRevenue).toBe(0);
  });

  it("treats null totals/amounts as 0", () => {
    const r = computeCustomerRollups(
      [{ status: "sent", total: null }],
      [{ amount: null }],
    );
    expect(r.totalInvoiced).toBe(0);
    expect(r.totalPaid).toBe(0);
  });
});

describe("sortTimelineDesc", () => {
  it("newest first across mixed kinds", () => {
    const sorted = sortTimelineDesc([
      { when: "2026-05-01T00:00:00Z", kind: "quote", label: "A" },
      { when: "2026-05-15T00:00:00Z", kind: "invoice", label: "B" },
      { when: "2026-05-10T00:00:00Z", kind: "job", label: "C" },
    ]);
    expect(sorted.map((e) => e.label)).toEqual(["B", "C", "A"]);
  });

  it("returns a new array (doesn't mutate the input)", () => {
    const input = [
      { when: "2026-05-01T00:00:00Z", kind: "quote", label: "A" },
      { when: "2026-05-15T00:00:00Z", kind: "invoice", label: "B" },
    ];
    const sorted = sortTimelineDesc(input);
    expect(sorted).not.toBe(input);
    expect(input[0]!.label).toBe("A"); // original untouched
  });
});
