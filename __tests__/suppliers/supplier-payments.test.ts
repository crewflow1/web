import { describe, expect, it } from "vitest";

import {
  ALLOCATION_TOLERANCE,
  billGross,
  computeBillSettlement,
  computeBillSettlements,
  computeSupplierPosition,
  isLivePayment,
  isSupplierPaymentMethod,
  liveAllocations,
  validateSupplierPaymentDraft,
  type SupplierAllocationRow,
  type SupplierBillRow,
  type SupplierPaymentRow,
} from "@/lib/suppliers/payments";
import { computeJobProfitability } from "@/lib/profitability/compute";
import { supplierPaymentSchema, voidSupplierPaymentSchema } from "@/lib/suppliers/schema";

/**
 * H2-CIS M2 — supplier payment (money-OUT) domain maths.
 *
 * The headline case is the LOAD-BEARING INVARIANT: CIS withholding is a tax
 * liability, not a discount. It reduces cash out and NOTHING else. Everything
 * else here is the penny-safety and allocation-cap arithmetic that keeps the
 * ledger honest before the database gets a chance to refuse it.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bill = (id: string, amount: number, vat = 0): SupplierBillRow => ({
  id,
  amount,
  vat_total: vat,
});

const payment = (
  id: string,
  gross: number,
  withheld = 0,
  voided_at: string | null = null,
): SupplierPaymentRow => ({
  id,
  paid_at: "2026-07-01",
  method: "bank_transfer",
  reference: null,
  gross_amount: gross,
  cis_withheld: withheld,
  net_paid: Math.round((gross - withheld) * 100) / 100,
  voided_at,
});

const alloc = (
  payment_id: string,
  finance_id: string,
  amount: number,
): SupplierAllocationRow => ({ payment_id, finance_id, amount });

// ---------------------------------------------------------------------------
// THE INVARIANT — CIS withholding must never reduce cost
// ---------------------------------------------------------------------------

describe("CIS withholding does not reduce commercial cost", () => {
  // The exact scenario from the milestone brief.
  const bills = [bill("b1", 10_000, 0)];
  const payments = [payment("p1", 10_000, 2_000)];
  const allocations = [alloc("p1", "b1", 10_000)];

  it("£10,000 gross with £2,000 CIS withheld is £8,000 cash but a £10,000 cost", () => {
    const pos = computeSupplierPosition({ bills, payments, allocations });

    expect(pos.billedNet, "the job still cost the full ten grand").toBe(10_000);
    expect(pos.billedGross).toBe(10_000);
    expect(pos.grossPaid, "the supplier's account was settled in full").toBe(10_000);
    expect(pos.cisWithheld).toBe(2_000);
    expect(pos.netCash, "only eight grand actually left the bank").toBe(8_000);
    expect(pos.outstanding, "nothing is still owed to them").toBe(0);
  });

  it("the withholding is NOT subtracted from any cost figure", () => {
    const withCis = computeSupplierPosition({ bills, payments, allocations });
    const withoutCis = computeSupplierPosition({
      bills,
      payments: [payment("p1", 10_000, 0)],
      allocations,
    });

    // The ONLY figures allowed to move are the two cash ones.
    expect(withCis.billedNet).toBe(withoutCis.billedNet);
    expect(withCis.billedGross).toBe(withoutCis.billedGross);
    expect(withCis.settled).toBe(withoutCis.settled);
    expect(withCis.outstanding).toBe(withoutCis.outstanding);
    expect(withCis.grossPaid).toBe(withoutCis.grossPaid);
    // …and they move by exactly the deduction.
    expect(withoutCis.netCash - withCis.netCash).toBe(2_000);
    expect(withCis.cisWithheld).toBe(2_000);
    expect(withoutCis.cisWithheld).toBe(0);
  });

  it("a bill's settlement status ignores the withholding entirely", () => {
    const s = computeBillSettlement({ bill: bills[0]!, allocations: [{ amount: 10_000 }] });
    expect(s.status, "the bill is PAID — £8,000 of cash settled £10,000 of bill").toBe("paid");
    expect(s.settled).toBe(10_000);
    expect(s.outstanding).toBe(0);
    expect(s.net, "the cost half of the bill is untouched").toBe(10_000);
  });

  it("job profitability is byte-identical whether or not CIS was withheld", () => {
    // Profitability reads `finances` rows only. This ledger never writes them,
    // so the two runs below are the same call with the same inputs — which is
    // exactly the point: there is no code path by which a payment could reach
    // the cost calculation. If someone later folds `cis_withheld` into a cost
    // roll-up, they must break this test to do it.
    const financeRows = [{ job_id: "j1", amount: 10_000, category: "subcontractor" }];
    const invoices = [{ job_id: "j1", amount: 14_000 }];

    const before = computeJobProfitability("j1", invoices, financeRows);
    const pos = computeSupplierPosition({ bills, payments, allocations });
    const after = computeJobProfitability("j1", invoices, financeRows);

    expect(after).toEqual(before);
    expect(after?.costs_total).toBe(10_000);
    expect(after?.gross_profit, "£4,000 margin — NOT £6,000").toBe(4_000);
    expect(after?.margin_pct).toBe(29);
    // The tempting-but-wrong number: cash out would have shown a £6,000 profit.
    expect(invoices[0]!.amount - pos.netCash).toBe(6_000);
    expect(after!.gross_profit).not.toBe(invoices[0]!.amount - pos.netCash);
  });

  it("a 30%-rate payment behaves the same way", () => {
    const pos = computeSupplierPosition({
      bills: [bill("b1", 5_000)],
      payments: [payment("p1", 5_000, 1_500)],
      allocations: [alloc("p1", "b1", 5_000)],
    });
    expect(pos.billedNet).toBe(5_000);
    expect(pos.netCash).toBe(3_500);
    expect(pos.cisWithheld).toBe(1_500);
    expect(pos.outstanding).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Non-CIS suppliers — the general payable path
// ---------------------------------------------------------------------------

describe("non-CIS suppliers", () => {
  it("a merchant with no withholding has net cash equal to gross settled", () => {
    const pos = computeSupplierPosition({
      bills: [bill("b1", 400, 80)], // £480 gross
      payments: [payment("p1", 480, 0)],
      allocations: [alloc("p1", "b1", 480)],
    });
    expect(pos.billedGross).toBe(480);
    expect(pos.billedNet).toBe(400);
    expect(pos.cisWithheld).toBe(0);
    expect(pos.netCash).toBe(480);
    expect(pos.grossPaid).toBe(pos.netCash);
    expect(pos.outstanding).toBe(0);
  });

  it("VAT is part of what you pay but never part of the cost", () => {
    const b = bill("b1", 1_000, 200);
    expect(billGross(b)).toBe(1_200);
    const s = computeBillSettlement({ bill: b, allocations: [{ amount: 1_200 }] });
    expect(s.gross).toBe(1_200);
    expect(s.net).toBe(1_000);
    expect(s.status).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Bill settlement
// ---------------------------------------------------------------------------

describe("computeBillSettlement", () => {
  it("an untouched bill is unpaid with everything outstanding", () => {
    const s = computeBillSettlement({ bill: bill("b1", 500, 100), allocations: [] });
    expect(s.status).toBe("unpaid");
    expect(s.settled).toBe(0);
    expect(s.outstanding).toBe(600);
  });

  it("a partial payment is part_paid", () => {
    const s = computeBillSettlement({ bill: bill("b1", 1_000), allocations: [{ amount: 400 }] });
    expect(s.status).toBe("part_paid");
    expect(s.outstanding).toBe(600);
  });

  it("several partials add up to paid", () => {
    const s = computeBillSettlement({
      bill: bill("b1", 1_000),
      allocations: [{ amount: 400 }, { amount: 350 }, { amount: 250 }],
    });
    expect(s.settled).toBe(1_000);
    expect(s.outstanding).toBe(0);
    expect(s.status).toBe("paid");
  });

  it("outstanding never goes negative even when over-paid", () => {
    const s = computeBillSettlement({ bill: bill("b1", 100), allocations: [{ amount: 150 }] });
    expect(s.status).toBe("over_paid");
    expect(s.outstanding).toBe(0);
  });

  it("a half-penny short still reads as paid (shared tolerance)", () => {
    const s = computeBillSettlement({
      bill: bill("b1", 100),
      allocations: [{ amount: 100 - ALLOCATION_TOLERANCE / 2 }],
    });
    expect(s.status).toBe("paid");
  });

  it("a whole penny short is still part_paid", () => {
    const s = computeBillSettlement({ bill: bill("b1", 100), allocations: [{ amount: 99.99 }] });
    expect(s.status).toBe("part_paid");
    expect(s.outstanding).toBe(0.01);
  });

  it("handles numeric strings from PostgREST", () => {
    const s = computeBillSettlement({
      bill: { id: "b1", amount: "1000.00", vat_total: "200.00" },
      allocations: [{ amount: "600.00" }, { amount: "600.00" }],
    });
    expect(s.gross).toBe(1_200);
    expect(s.settled).toBe(1_200);
    expect(s.status).toBe("paid");
  });

  it("nulls coerce to zero rather than NaN", () => {
    const s = computeBillSettlement({
      bill: { id: "b1", amount: null, vat_total: null },
      allocations: [],
    });
    expect(s.gross).toBe(0);
    expect(s.outstanding).toBe(0);
    expect(s.status).toBe("unpaid");
  });
});

// ---------------------------------------------------------------------------
// Voided payments
// ---------------------------------------------------------------------------

describe("voided payments", () => {
  const bills = [bill("b1", 1_000)];

  it("a voided payment contributes nothing to cash, withholding or settlement", () => {
    const pos = computeSupplierPosition({
      bills,
      payments: [payment("p1", 1_000, 200, "2026-07-05T10:00:00Z")],
      allocations: [alloc("p1", "b1", 1_000)],
    });
    expect(pos.grossPaid).toBe(0);
    expect(pos.netCash).toBe(0);
    expect(pos.cisWithheld).toBe(0);
    expect(pos.settled, "its allocation settles nothing").toBe(0);
    expect(pos.outstanding, "the bill is owed again").toBe(1_000);
    expect(pos.counts.voidedPayments).toBe(1);
    expect(pos.counts.payments).toBe(0);
  });

  it("void-then-re-record leaves exactly one live payment", () => {
    const pos = computeSupplierPosition({
      bills,
      payments: [
        payment("p1", 1_000, 200, "2026-07-05T10:00:00Z"), // the mistake
        payment("p2", 1_000, 300), // the correction
      ],
      allocations: [alloc("p1", "b1", 1_000), alloc("p2", "b1", 1_000)],
    });
    expect(pos.grossPaid).toBe(1_000);
    expect(pos.cisWithheld).toBe(300);
    expect(pos.netCash).toBe(700);
    expect(pos.settled).toBe(1_000);
    expect(pos.outstanding).toBe(0);
    expect(pos.counts.voidedPayments).toBe(1);
  });

  it("isLivePayment / liveAllocations agree with the position maths", () => {
    const payments = [payment("p1", 100, 0, "2026-07-05T10:00:00Z"), payment("p2", 100)];
    expect(isLivePayment(payments[0]!)).toBe(false);
    expect(isLivePayment(payments[1]!)).toBe(true);
    const live = liveAllocations([alloc("p1", "b1", 100), alloc("p2", "b1", 100)], payments);
    expect(live).toHaveLength(1);
    expect(live[0]!.payment_id).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// Supplier position — multi-bill / multi-payment
// ---------------------------------------------------------------------------

describe("computeSupplierPosition", () => {
  it("aggregates several bills and several partial payments", () => {
    const bills = [bill("b1", 1_000, 200), bill("b2", 500, 100), bill("b3", 250, 50)];
    const payments = [payment("p1", 1_200, 240), payment("p2", 300, 60)];
    const allocations = [alloc("p1", "b1", 1_200), alloc("p2", "b2", 300)];

    const pos = computeSupplierPosition({ bills, payments, allocations });
    expect(pos.billedNet).toBe(1_750);
    expect(pos.billedGross).toBe(2_100);
    expect(pos.settled).toBe(1_500);
    expect(pos.outstanding).toBe(600); // b2 has 300 left, b3 all 300
    expect(pos.grossPaid).toBe(1_500);
    expect(pos.cisWithheld).toBe(300);
    expect(pos.netCash).toBe(1_200);
    expect(pos.counts).toEqual({ bills: 3, payments: 2, voidedPayments: 0, unpaidBills: 2 });
  });

  it("over-settling ONE bill never pays down another (per-bill capping)", () => {
    // The money-in ledger's F2 defect, on the money-out side.
    const bills = [bill("b1", 100), bill("b2", 100)];
    const payments = [payment("p1", 250)];
    const allocations = [alloc("p1", "b1", 150)]; // 150 against a 100 bill

    const pos = computeSupplierPosition({ bills, payments, allocations });
    expect(pos.outstanding, "b2's £100 is still owed — b1's overpayment is not credit").toBe(100);
    expect(pos.settled, "the raw settled total is still honest").toBe(150);
    expect(pos.billedGross).toBe(200);
    // The naive figure would have been 200 - 150 = 50. It is not.
    expect(pos.outstanding).not.toBe(50);
  });

  it("payment on account shows as unallocated, not as settlement", () => {
    const pos = computeSupplierPosition({
      bills: [bill("b1", 1_000)],
      payments: [payment("p1", 1_000)],
      allocations: [], // paid, but not matched to the bill yet
    });
    expect(pos.grossPaid).toBe(1_000);
    expect(pos.settled).toBe(0);
    expect(pos.unallocated).toBe(1_000);
    expect(pos.outstanding, "the bill is untouched until it's allocated").toBe(1_000);
  });

  it("an empty supplier is all zeroes, not NaN", () => {
    const pos = computeSupplierPosition({ bills: [], payments: [], allocations: [] });
    expect(pos).toMatchObject({
      billedNet: 0,
      billedGross: 0,
      settled: 0,
      outstanding: 0,
      grossPaid: 0,
      cisWithheld: 0,
      netCash: 0,
      unallocated: 0,
    });
  });

  it("computeBillSettlements returns one row per bill, in order", () => {
    const bills = [bill("b1", 100), bill("b2", 200), bill("b3", 300)];
    const rows = computeBillSettlements({
      bills,
      payments: [payment("p1", 150)],
      allocations: [alloc("p1", "b2", 150)],
    });
    expect(rows.map((r) => r.billId)).toEqual(["b1", "b2", "b3"]);
    expect(rows[1]!.settled).toBe(150);
    expect(rows[1]!.outstanding).toBe(50);
    expect(rows[0]!.settled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Penny safety
// ---------------------------------------------------------------------------

describe("penny safety", () => {
  it("0.1 + 0.2 style drift never leaks into a total", () => {
    const pos = computeSupplierPosition({
      bills: [bill("b1", 0.1), bill("b2", 0.2)],
      payments: [payment("p1", 0.3)],
      allocations: [alloc("p1", "b1", 0.1), alloc("p1", "b2", 0.2)],
    });
    expect(pos.billedNet).toBe(0.3);
    expect(pos.settled).toBe(0.3);
    expect(pos.outstanding).toBe(0);
    expect(pos.netCash).toBe(0.3);
  });

  it("a one-penny bill settles exactly", () => {
    const s = computeBillSettlement({ bill: bill("b1", 0.01), allocations: [{ amount: 0.01 }] });
    expect(s.gross).toBe(0.01);
    expect(s.status).toBe("paid");
    expect(s.outstanding).toBe(0);
  });

  it("a zero-value bill is 'paid' with nothing outstanding", () => {
    const s = computeBillSettlement({ bill: bill("b1", 0), allocations: [] });
    expect(s.gross).toBe(0);
    expect(s.outstanding).toBe(0);
    // 0 settled of 0 gross: unpaid by the settled-is-zero rule, and outstanding
    // is 0 either way — the important part is that it is never NaN or negative.
    expect(s.status).toBe("unpaid");
  });

  it("a penny of CIS on a penny payment still balances", () => {
    const pos = computeSupplierPosition({
      bills: [bill("b1", 0.01)],
      payments: [payment("p1", 0.01, 0.01)],
      allocations: [alloc("p1", "b1", 0.01)],
    });
    expect(pos.netCash).toBe(0);
    expect(pos.cisWithheld).toBe(0.01);
    expect(pos.billedNet, "even here the cost is the full penny").toBe(0.01);
  });

  it("100 tiny allocations sum without drift", () => {
    const allocations = Array.from({ length: 100 }, () => ({ amount: 0.01 }));
    const s = computeBillSettlement({ bill: bill("b1", 1), allocations });
    expect(s.settled).toBe(1);
    expect(s.status).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

describe("validateSupplierPaymentDraft", () => {
  const outstanding = new Map([
    ["b1", 1_000],
    ["b2", 500],
  ]);

  it("accepts a clean payment and derives the cash line", () => {
    const v = validateSupplierPaymentDraft(
      {
        grossAmount: 1_000,
        cisWithheld: 200,
        allocations: [{ financeId: "b1", amount: 1_000 }],
      },
      outstanding,
    );
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.gross).toBe(1_000);
    expect(v.withheld).toBe(200);
    expect(v.net).toBe(800);
    expect(v.allocated).toBe(1_000);
    expect(v.unallocated).toBe(0);
  });

  it("accepts a payment left wholly on account", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 500, cisWithheld: 0, allocations: [] },
      outstanding,
    );
    expect(v.ok).toBe(true);
    expect(v.unallocated).toBe(500);
  });

  it("refuses withholding more than the payment settles", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 100, cisWithheld: 200, allocations: [] },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/withhold/i);
  });

  it("refuses a negative amount", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: -1, cisWithheld: 0, allocations: [] },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/negative/i);
  });

  it("refuses allocating more than the payment", () => {
    const v = validateSupplierPaymentDraft(
      {
        grossAmount: 1_000,
        cisWithheld: 0,
        allocations: [
          { financeId: "b1", amount: 700 },
          { financeId: "b2", amount: 400 },
        ],
      },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/allocated 1100\.00 of a 1000\.00 payment/i);
  });

  it("refuses paying more against a bill than it has outstanding", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 2_000, cisWithheld: 0, allocations: [{ financeId: "b2", amount: 900 }] },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/900\.00 against a bill with 500\.00 outstanding/i);
  });

  it("refuses a bill that is not this supplier's", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 100, cisWithheld: 0, allocations: [{ financeId: "other", amount: 100 }] },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/isn't an open bill/i);
  });

  it("refuses a zero or negative line", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 100, cisWithheld: 0, allocations: [{ financeId: "b1", amount: 0 }] },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/greater than zero/i);
  });

  it("refuses the same bill listed twice", () => {
    const v = validateSupplierPaymentDraft(
      {
        grossAmount: 100,
        cisWithheld: 0,
        allocations: [
          { financeId: "b1", amount: 50 },
          { financeId: "b1", amount: 50 },
        ],
      },
      outstanding,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/listed twice/i);
  });

  it("de-duplicates repeated messages", () => {
    const v = validateSupplierPaymentDraft(
      {
        grossAmount: 100,
        cisWithheld: 0,
        allocations: [
          { financeId: "b1", amount: 0 },
          { financeId: "b2", amount: 0 },
        ],
      },
      outstanding,
    );
    expect(v.errors.filter((e) => /greater than zero/.test(e))).toHaveLength(1);
  });

  it("allows a half-penny of float noise on both caps", () => {
    const v = validateSupplierPaymentDraft(
      {
        grossAmount: 1_000,
        cisWithheld: 0,
        allocations: [{ financeId: "b1", amount: 1_000 + ALLOCATION_TOLERANCE / 2 }],
      },
      outstanding,
    );
    expect(v.ok).toBe(true);
  });

  it("a zero payment with no lines is valid (the DB permits it too)", () => {
    const v = validateSupplierPaymentDraft(
      { grossAmount: 0, cisWithheld: 0, allocations: [] },
      outstanding,
    );
    expect(v.ok).toBe(true);
    expect(v.net).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("supplierPaymentSchema", () => {
  const base = {
    gross_amount: "1000",
    cis_withheld: "200",
    paid_at: "2026-07-01",
    method: "bank_transfer",
    reference: "TT-1",
    notes: "",
    allocations: [{ finance_id: "8b1c9c7e-1f1a-4a52-9f2f-0a6b0d7e1a11", amount: 1000 }],
  };

  it("coerces the money strings a form sends", () => {
    const parsed = supplierPaymentSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.gross_amount).toBe(1_000);
      expect(parsed.data.cis_withheld).toBe(200);
      expect(parsed.data.reference).toBe("TT-1");
    }
  });

  it("an untouched reference becomes undefined, not '' — the dedupe guard needs NULL", () => {
    const parsed = supplierPaymentSchema.safeParse({ ...base, reference: "", notes: "   " });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reference).toBeUndefined();
      expect(parsed.data.notes).toBeUndefined();
    }
  });

  it("refuses withholding more than the gross", () => {
    const parsed = supplierPaymentSchema.safeParse({ ...base, cis_withheld: "2000" });
    expect(parsed.success).toBe(false);
  });

  it("refuses a negative payment", () => {
    expect(supplierPaymentSchema.safeParse({ ...base, gross_amount: "-1" }).success).toBe(false);
  });

  it("refuses a non-date", () => {
    expect(supplierPaymentSchema.safeParse({ ...base, paid_at: "01/07/2026" }).success).toBe(false);
  });

  it("refuses an unknown method", () => {
    expect(supplierPaymentSchema.safeParse({ ...base, method: "crypto" }).success).toBe(false);
  });

  it("refuses a zero-amount allocation line", () => {
    const parsed = supplierPaymentSchema.safeParse({
      ...base,
      allocations: [{ finance_id: "8b1c9c7e-1f1a-4a52-9f2f-0a6b0d7e1a11", amount: 0 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults withholding to zero and allocations to empty", () => {
    const parsed = supplierPaymentSchema.safeParse({
      gross_amount: "50",
      paid_at: "2026-07-01",
      method: "cash",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cis_withheld).toBe(0);
      expect(parsed.data.allocations).toEqual([]);
    }
  });
});

describe("voidSupplierPaymentSchema", () => {
  const id = "8b1c9c7e-1f1a-4a52-9f2f-0a6b0d7e1a11";

  it("requires a reason", () => {
    expect(voidSupplierPaymentSchema.safeParse({ payment_id: id, void_reason: "" }).success).toBe(
      false,
    );
  });

  it("refuses whitespace as a reason", () => {
    expect(
      voidSupplierPaymentSchema.safeParse({ payment_id: id, void_reason: "   " }).success,
    ).toBe(false);
  });

  it("accepts a real reason", () => {
    const parsed = voidSupplierPaymentSchema.safeParse({
      payment_id: id,
      void_reason: "  Keyed the wrong amount  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.void_reason).toBe("Keyed the wrong amount");
  });
});

describe("isSupplierPaymentMethod", () => {
  it("accepts the DB's method list and nothing else", () => {
    expect(isSupplierPaymentMethod("bank_transfer")).toBe(true);
    expect(isSupplierPaymentMethod("cheque")).toBe(true);
    expect(isSupplierPaymentMethod("bacs")).toBe(false);
    expect(isSupplierPaymentMethod(null)).toBe(false);
  });
});
