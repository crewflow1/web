import { describe, it, expect } from "vitest";
import {
  computeCommercialCash,
  hasCommercialCash,
  type CashQuote,
  type CashInvoice,
  type CashPayment,
} from "@/lib/commercial/cash";

const NOW = new Date("2026-07-21T12:00:00Z");

function cash(over: {
  quotes?: CashQuote[];
  invoices?: CashInvoice[];
  payments?: CashPayment[];
}) {
  return computeCommercialCash({
    quotes: over.quotes ?? [],
    invoices: over.invoices ?? [],
    payments: over.payments ?? [],
    now: NOW,
  });
}

describe("computeCommercialCash — contract", () => {
  it("derives revised from original + approved variations; pending shown separately", () => {
    const c = cash({
      quotes: [
        { status: "accepted", total: 10000, variation_number: null },
        { status: "accepted", total: 2000, variation_number: 1 },
        { status: "sent", total: 500, variation_number: 2 }, // pending
        { status: "declined", total: 9999, variation_number: 3 }, // ignored
      ],
    });
    expect(c.original).toBe(10000);
    expect(c.approvedVariations).toBe(2000);
    expect(c.revised).toBe(12000);
    expect(c.pendingVariations).toBe(500);
    expect(c.counts.approvedVariations).toBe(1);
    expect(c.counts.pendingVariations).toBe(1);
  });

  it("does not fold pending variations into the revised value", () => {
    const c = cash({
      quotes: [
        { status: "accepted", total: 10000, variation_number: null },
        { status: "viewed", total: 3000, variation_number: 1 },
      ],
    });
    expect(c.revised).toBe(10000);
    expect(c.pendingVariations).toBe(3000);
  });
});

describe("computeCommercialCash — the ledger-truth fix (the headline defect)", () => {
  it("a partially-paid invoice shows the REAL outstanding, not £0", () => {
    // £20k invoice, £5k received → the old status-based math read £0 outstanding.
    const c = cash({
      invoices: [{ id: "inv1", status: "partially_paid", total: 20000, due_date: "2026-08-01" }],
      payments: [{ invoice_id: "inv1", amount: 5000 }],
    });
    expect(c.billed).toBe(20000);
    expect(c.received).toBe(5000);
    expect(c.outstanding).toBe(15000); // <- was £0 under the status heuristic
  });

  it("sums multiple partial payments per invoice", () => {
    const c = cash({
      invoices: [{ id: "inv1", status: "partially_paid", total: 1000, due_date: "2026-09-01" }],
      payments: [
        { invoice_id: "inv1", amount: 300 },
        { invoice_id: "inv1", amount: 250 },
      ],
    });
    expect(c.received).toBe(550);
    expect(c.outstanding).toBe(450);
  });

  it("a fully paid invoice is zero outstanding", () => {
    const c = cash({
      invoices: [{ id: "inv1", status: "paid", total: 1000, due_date: "2026-09-01" }],
      payments: [{ invoice_id: "inv1", amount: 1000 }],
    });
    expect(c.outstanding).toBe(0);
  });

  it("never returns negative outstanding on over-payment", () => {
    const c = cash({
      invoices: [{ id: "inv1", status: "paid", total: 1000, due_date: "2026-09-01" }],
      payments: [{ invoice_id: "inv1", amount: 1200 }],
    });
    expect(c.outstanding).toBe(0);
  });

  it("an overpayment on ONE invoice does not pay down another (per-invoice cap)", () => {
    // Two £10k invoices on this job; A over-allocated £15k, B unpaid + past due.
    // The true debtor is B's full £10k — an overpayment on A must NOT net it down to
    // £5k (billed−received), and `overdue` (already per-invoice capped) must never
    // exceed `outstanding`. This is the cross-invoice understatement the naive
    // `billed − received` produced.
    const c = cash({
      invoices: [
        { id: "invA", status: "partially_paid", total: 10000, due_date: "2026-08-01" },
        { id: "invB", status: "sent", total: 10000, due_date: "2026-06-01" },
      ],
      payments: [{ invoice_id: "invA", amount: 15000 }],
    });
    expect(c.billed).toBe(20000);
    expect(c.received).toBe(15000); // true cash received (uncapped)
    expect(c.outstanding).toBe(10000); // B's balance — NOT billed − received (£5k)
    expect(c.overdue).toBe(10000); // B is past due
    expect(c.overdue).toBeLessThanOrEqual(c.outstanding); // the invariant that was violable
  });
});

describe("computeCommercialCash — F2 tenancy invariant", () => {
  it("ignores payments allocated to invoices that are NOT this job's", () => {
    // A receipt split across this job (inv1) and another job/customer (other).
    const c = cash({
      invoices: [{ id: "inv1", status: "partially_paid", total: 1000, due_date: "2026-09-01" }],
      payments: [
        { invoice_id: "inv1", amount: 400 },
        { invoice_id: "other-job-invoice", amount: 600 }, // must NOT count here
      ],
    });
    expect(c.received).toBe(400); // not 1000
    expect(c.outstanding).toBe(600);
  });
});

describe("computeCommercialCash — overdue + still-to-bill", () => {
  it("counts only the unpaid balance of past-due invoices as overdue", () => {
    const c = cash({
      invoices: [
        { id: "inv1", status: "partially_paid", total: 1000, due_date: "2026-06-01" }, // past due
        { id: "inv2", status: "sent", total: 500, due_date: "2026-12-01" }, // future
      ],
      payments: [{ invoice_id: "inv1", amount: 400 }],
    });
    expect(c.outstanding).toBe(1100); // (1000-400) + 500
    expect(c.overdue).toBe(600); // only inv1's remaining balance
    expect(c.counts.overdueInvoices).toBe(1);
  });

  it("an invoice with no due date is never overdue", () => {
    const c = cash({
      invoices: [{ id: "inv1", status: "sent", total: 1000, due_date: null }],
    });
    expect(c.overdue).toBe(0);
  });

  it("still-to-bill is revised minus billed, floored at zero", () => {
    const c = cash({
      quotes: [{ status: "accepted", total: 10000, variation_number: null }],
      invoices: [{ id: "inv1", status: "sent", total: 4000, due_date: "2026-09-01" }],
    });
    expect(c.stillToBill).toBe(6000);
  });

  it("over-billing (invoiced beyond contract) floors still-to-bill at zero", () => {
    const c = cash({
      quotes: [{ status: "accepted", total: 1000, variation_number: null }],
      invoices: [{ id: "inv1", status: "sent", total: 4000, due_date: "2026-09-01" }],
    });
    expect(c.stillToBill).toBe(0);
  });

  it("draft invoices are not billed", () => {
    const c = cash({
      invoices: [{ id: "inv1", status: "draft", total: 4000, due_date: "2026-09-01" }],
    });
    expect(c.billed).toBe(0);
  });
});

describe("hasCommercialCash", () => {
  it("is false for an empty job and true once there is a contract or billing", () => {
    expect(hasCommercialCash(cash({}))).toBe(false);
    expect(
      hasCommercialCash(cash({ quotes: [{ status: "accepted", total: 100, variation_number: null }] })),
    ).toBe(true);
  });
});
