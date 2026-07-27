import { describe, it, expect } from "vitest";
import {
  computeJobCashForecast,
  aggregateCashForecast,
  type ForecastInvoice,
  type ForecastStage,
  type ForecastQuote,
} from "@/lib/commercial/cash-forecast";

const NOW = new Date("2026-07-26T09:00:00Z");
const inv = (o: Partial<ForecastInvoice>): ForecastInvoice => ({
  status: o.status ?? "sent",
  total: o.total ?? 0,
  due_date: o.due_date ?? null,
  paid: o.paid ?? 0,
});
const stage = (o: Partial<ForecastStage>): ForecastStage => ({
  invoice_id: o.invoice_id ?? null,
  amount: o.amount ?? 0,
  vat_rate: o.vat_rate ?? 20,
  due_date: o.due_date ?? null,
});
const q = (variation_number: number | null, status: string, total: number): ForecastQuote => ({ variation_number, status, total });

describe("computeJobCashForecast — due vs planned vs unscheduled", () => {
  it("buckets invoiced debt by overdue / next-7 / next-30 / later and partitions the contract", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 50_000), q(1, "accepted", 10_000)], // revised 60,000
      invoices: [
        inv({ total: 4800, due_date: "2026-07-01", status: "sent" }), // overdue
        inv({ total: 6000, due_date: "2026-07-30", status: "sent" }), // 4 days → next7
        inv({ total: 3600, due_date: "2026-08-20", status: "sent" }), // 25 days → next30
        inv({ total: 1200, due_date: "2026-09-30", status: "sent" }), // later
        inv({ total: 2400, paid: 2400, status: "paid" }), // paid → billed, not collectable
        inv({ total: 1000, status: "draft" }), // drafted, not issued
      ],
      stages: [
        stage({ amount: 5000, vat_rate: 20, due_date: "2026-08-01" }), // gross 6000, 6 days → next7
        stage({ amount: 10_000, vat_rate: 20, due_date: null }), // gross 12,000, undated
        stage({ amount: 2000, vat_rate: 20, invoice_id: "inv-x" }), // invoiced → skipped
      ],
    });

    expect(f.overdue).toBe(4800);
    expect(f.due.next7).toBe(6000);
    expect(f.due.next30).toBe(3600);
    expect(f.due.later).toBe(1200);
    expect(f.draftedNotIssued).toBe(1000);
    expect(f.planned.next7).toBe(6000);
    expect(f.planned.undated).toBe(12_000);
    expect(f.plannedTotal).toBe(18_000);

    expect(f.revised).toBe(60_000);
    expect(f.billed).toBe(18_000); // 4800+6000+3600+1200+2400 (draft excluded)
    expect(f.stillToBill).toBe(42_000);
    expect(f.unscheduled).toBe(23_000); // 42,000 − 18,000 planned − 1,000 drafted

    // Reconciliation: billed + drafted + plannedCapped + unscheduled === revised.
    expect(f.plannedCapped).toBe(18_000); // under the contract, so uncapped
    expect(f.billed + f.draftedNotIssued + f.plannedCapped + f.unscheduled).toBe(60_000);
  });

  it("[cap] planned billing that over-carves the contract is capped, and the identity still holds", () => {
    // Zero-rated £50k contract, but two stages left at the 20% VAT default → raw
    // stage gross £60k > contract. plannedCapped must not exceed the contract.
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 50_000)],
      invoices: [],
      stages: [
        stage({ amount: 25_000, vat_rate: 20 }), // gross 30,000
        stage({ amount: 25_000, vat_rate: 20 }), // gross 30,000
      ],
    });
    expect(f.plannedTotal).toBe(60_000); // raw stage gross
    expect(f.plannedCapped).toBe(50_000); // capped at the live contract
    expect(f.unscheduled).toBe(0);
    // Identity holds on the capped figure.
    expect(f.billed + f.draftedNotIssued + f.plannedCapped + f.unscheduled).toBe(50_000);
  });

  it("[signed] an accepted omission (negative) variation REDUCES revised, matching the cash authority", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 50_000), q(1, "accepted", -8000)], // omission
      invoices: [],
      stages: [],
    });
    expect(f.revised).toBe(42_000); // signed sum, NOT a per-quote floor to 50,000
    expect(f.unscheduled).toBe(42_000);
  });

  it("[variation drift fix] an approved variation with no stage lands in UNSCHEDULED via the live contract", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 50_000), q(2, "accepted", 10_000)], // variation approved AFTER any plan
      invoices: [],
      stages: [], // frozen plan basis would MISS the variation; live revised does not
    });
    expect(f.revised).toBe(60_000);
    expect(f.unscheduled).toBe(60_000); // the whole live contract is unscheduled — the variation is included
  });

  it("pending (sent/viewed) variations are NOT in the contract", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 50_000), q(1, "sent", 10_000)],
      invoices: [],
      stages: [],
    });
    expect(f.revised).toBe(50_000);
  });

  it("overpayment never creates negative debt (per-invoice floor)", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [],
      invoices: [
        inv({ total: 5000, paid: 6000, status: "partially_paid", due_date: "2026-07-30" }), // overpaid
      ],
      stages: [],
    });
    expect(f.due.next7).toBe(0); // remaining floored at 0, not −1000
    expect(f.overdue).toBe(0);
  });

  it("a collectable invoice with no due date is 'undated', never silently overdue", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [],
      invoices: [inv({ total: 3000, status: "sent", due_date: null })],
      stages: [],
    });
    expect(f.overdue).toBe(0);
    expect(f.due.undated).toBe(3000);
  });

  it("stage VAT is added on top of the ex-VAT amount for the gross planned figure", () => {
    const f = computeJobCashForecast({
      now: NOW,
      quotes: [],
      invoices: [],
      stages: [
        stage({ amount: 1000, vat_rate: 0, due_date: "2026-08-01" }), // gross 1000
        stage({ amount: 1000, vat_rate: 5, due_date: "2026-08-01" }), // gross 1050
      ],
    });
    expect(f.planned.next7).toBe(2050);
  });
});

describe("aggregateCashForecast — org === Σ jobs", () => {
  it("sums per-job forecasts into the org outlook with cumulative windows", () => {
    const a = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 20_000)],
      invoices: [inv({ total: 5000, due_date: "2026-07-30", status: "sent" })], // next7
      stages: [stage({ amount: 1000, vat_rate: 20, due_date: "2026-08-20" })], // gross 1200 next30
    });
    const b = computeJobCashForecast({
      now: NOW,
      quotes: [q(null, "accepted", 10_000)],
      invoices: [inv({ total: 2000, due_date: "2026-07-01", status: "sent" })], // overdue
      stages: [],
    });
    const org = aggregateCashForecast([a, b]);
    expect(org.overdue).toBe(2000);
    expect(org.due.next7).toBe(5000);
    expect(org.dueNext7).toBe(5000);
    expect(org.dueNext30).toBe(5000); // next7 + next30 (b has no future-dated due)
    expect(org.planned.next30).toBe(1200);
    expect(org.plannedNext30).toBe(1200);
    expect(org.revised).toBe(30_000);
  });
});
