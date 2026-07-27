import { describe, expect, it } from "vitest";
import {
  computeRetentionPosition,
  maxReleasable,
} from "@/lib/retentions/compute";

describe("computeRetentionPosition", () => {
  it("accrues rate% of non-draft invoiced NET value; VAT is not retained", () => {
    const p = computeRetentionPosition({
      ratePercent: 5,
      invoices: [
        { status: "sent", amount: 10000 }, // certified
        { status: "paid", amount: 6000 }, // certified
        { status: "draft", amount: 4000 }, // NOT yet certified → excluded
      ],
      releases: [],
    });
    expect(p.invoicedBase).toBe(16000); // 10000 + 6000, draft excluded
    expect(p.accrued).toBe(800); // 5% of 16000
    expect(p.released).toBe(0);
    expect(p.held).toBe(800);
    expect(p.isActive).toBe(true);
    expect(p.isFullyReleased).toBe(false);
  });

  it("nets releases against accrued to derive held", () => {
    const p = computeRetentionPosition({
      ratePercent: 5,
      invoices: [{ status: "paid", amount: 20000 }],
      releases: [{ amount: 500 }, { amount: 250 }],
    });
    expect(p.accrued).toBe(1000);
    expect(p.released).toBe(750);
    expect(p.held).toBe(250);
    expect(maxReleasable(p)).toBe(250);
  });

  it("is fully released once everything accrued is returned", () => {
    const p = computeRetentionPosition({
      ratePercent: 3,
      invoices: [{ status: "paid", amount: 10000 }],
      releases: [{ amount: 300 }],
    });
    expect(p.accrued).toBe(300);
    expect(p.held).toBe(0);
    expect(p.isFullyReleased).toBe(true);
    expect(maxReleasable(p)).toBe(0);
  });

  it("never reports negative held (over-release can't happen in the read model)", () => {
    const p = computeRetentionPosition({
      ratePercent: 5,
      invoices: [{ status: "paid", amount: 1000 }],
      releases: [{ amount: 50 }, { amount: 999 }], // more than accrued (bad data)
    });
    expect(p.accrued).toBe(50);
    expect(p.held).toBe(0); // clamped, not -999
  });

  it("is inactive and zero for a contract with no retention", () => {
    const p = computeRetentionPosition({
      ratePercent: 0,
      invoices: [{ status: "paid", amount: 50000 }],
      releases: [],
    });
    expect(p.isActive).toBe(false);
    expect(p.accrued).toBe(0);
    expect(p.held).toBe(0);
    expect(p.isFullyReleased).toBe(false); // nothing accrued
  });

  it("coerces numeric-string inputs and clamps an out-of-range rate", () => {
    const p = computeRetentionPosition({
      ratePercent: "150", // clamped to 100
      invoices: [{ status: "sent", amount: "1000.00" }],
      releases: [{ amount: "100" }],
    });
    expect(p.ratePercent).toBe(100);
    expect(p.accrued).toBe(1000);
    expect(p.held).toBe(900);
  });

  it("rounds accrual to 2dp without float drift", () => {
    const p = computeRetentionPosition({
      ratePercent: 5,
      invoices: [{ status: "sent", amount: 333.33 }],
      releases: [],
    });
    // 5% of 333.33 = 16.6665 → 16.67
    expect(p.accrued).toBe(16.67);
  });
});
