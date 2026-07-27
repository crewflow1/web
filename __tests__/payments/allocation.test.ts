import { describe, it, expect } from "vitest";
import {
  computePaymentAllocation,
  computeInvoiceBalance,
  PAYMENT_ALLOCATION_STATUS_LABEL,
  PAYMENT_ALLOCATION_STATUS_CLASS,
  ALLOCATION_TOLERANCE,
} from "@/lib/payments/allocation";

describe("computePaymentAllocation", () => {
  it("reports a fresh payment as fully unallocated", () => {
    const pos = computePaymentAllocation({ paymentAmount: 1000, allocations: [] });
    expect(pos.paymentAmount).toBe(1000);
    expect(pos.allocated).toBe(0);
    expect(pos.unallocated).toBe(1000);
    expect(pos.count).toBe(0);
    expect(pos.status).toBe("unallocated");
  });

  it("reports part allocation across several invoices", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 1000,
      allocations: [{ amount: 300 }, { amount: 200 }],
    });
    expect(pos.allocated).toBe(500);
    expect(pos.unallocated).toBe(500);
    expect(pos.count).toBe(2);
    expect(pos.status).toBe("part_allocated");
  });

  it("reports full allocation when the sum meets the payment", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 1000,
      allocations: [{ amount: 600 }, { amount: 400 }],
    });
    expect(pos.allocated).toBe(1000);
    expect(pos.unallocated).toBe(0);
    expect(pos.status).toBe("fully_allocated");
  });

  it("flags over-allocation (the DB guard would reject this)", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 1000,
      allocations: [{ amount: 600 }, { amount: 500 }],
    });
    expect(pos.allocated).toBe(1100);
    expect(pos.unallocated).toBe(0); // clamped, never negative
    expect(pos.status).toBe("over_allocated");
  });

  it("never returns a negative unallocated balance", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 50,
      allocations: [{ amount: 999 }],
    });
    expect(pos.unallocated).toBe(0);
  });

  it("absorbs sub-penny float noise within tolerance (fully allocated)", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 100,
      allocations: [{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.34 }],
    });
    expect(pos.allocated).toBe(100);
    expect(pos.status).toBe("fully_allocated");
  });

  it("coerces string/null amounts like DB numeric values", () => {
    const pos = computePaymentAllocation({
      paymentAmount: "1000.00",
      allocations: [{ amount: "250.50" }, { amount: null }, { amount: undefined }],
    });
    expect(pos.allocated).toBe(250.5);
    expect(pos.unallocated).toBe(749.5);
    expect(pos.status).toBe("part_allocated");
  });

  it("treats an allocation just over the payment (beyond tolerance) as over-allocated", () => {
    const pos = computePaymentAllocation({
      paymentAmount: 100,
      allocations: [{ amount: 100 + ALLOCATION_TOLERANCE * 3 }],
    });
    expect(pos.status).toBe("over_allocated");
  });
});

describe("computeInvoiceBalance", () => {
  it("reports an unpaid invoice", () => {
    const bal = computeInvoiceBalance({ invoiceTotal: 1200, payments: [] });
    expect(bal.paid).toBe(0);
    expect(bal.outstanding).toBe(1200);
    expect(bal.status).toBe("unpaid");
  });

  it("reports a part-paid invoice (mirrors the status trigger)", () => {
    const bal = computeInvoiceBalance({
      invoiceTotal: 1200,
      payments: [{ amount: 500 }],
    });
    expect(bal.outstanding).toBe(700);
    expect(bal.status).toBe("part_paid");
  });

  it("reports a fully paid invoice when payments meet the total", () => {
    const bal = computeInvoiceBalance({
      invoiceTotal: 1200,
      payments: [{ amount: 700 }, { amount: 500 }],
    });
    expect(bal.outstanding).toBe(0);
    expect(bal.status).toBe("paid");
  });

  it("reports over-payment (deposit/credit) with zero outstanding", () => {
    const bal = computeInvoiceBalance({
      invoiceTotal: 1000,
      payments: [{ amount: 1200 }],
    });
    expect(bal.paid).toBe(1200);
    expect(bal.outstanding).toBe(0);
    expect(bal.status).toBe("over_paid");
  });

  it("coerces VAT-inclusive string totals", () => {
    const bal = computeInvoiceBalance({
      invoiceTotal: "1440.00",
      payments: [{ amount: "1440.00" }],
    });
    expect(bal.status).toBe("paid");
    expect(bal.outstanding).toBe(0);
  });
});

describe("status metadata", () => {
  it("has a label and class for every payment allocation status", () => {
    for (const s of ["unallocated", "part_allocated", "fully_allocated", "over_allocated"] as const) {
      expect(PAYMENT_ALLOCATION_STATUS_LABEL[s]).toBeTruthy();
      expect(PAYMENT_ALLOCATION_STATUS_CLASS[s]).toContain("text-");
    }
  });
});
