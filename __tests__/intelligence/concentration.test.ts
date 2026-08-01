import { describe, it, expect } from "vitest";
import { trailingMonthsWindow } from "@/lib/intelligence/window";
import {
  MIN_CONCENTRATION_INVOICES,
  TOP1_CONCENTRATION_PCT,
  TOP3_CONCENTRATION_PCT,
  UNATTRIBUTED_LABEL,
  computeCustomerConcentration,
  concentrationFlagMetric,
  concentrationSharesMetric,
  type ConcentrationInvoice,
} from "@/lib/intelligence/concentration";

const NOW = new Date("2026-07-31T23:30:00Z"); // London: 1 Aug 2026
const WINDOW = trailingMonthsWindow(NOW, 12); // 2025-08-01 .. 2026-08-01

let seq = 0;
function inv(over: Partial<ConcentrationInvoice>): ConcentrationInvoice {
  seq += 1;
  return {
    id: `inv-${seq}`,
    status: "sent",
    amount: 100,
    created_at: "2026-06-01T10:00:00Z",
    customer_id: "c-1",
    job_id: null,
    ...over,
  };
}

const naming = {
  customerName: new Map([
    ["c-1", "Acme Builders"],
    ["c-2", "Beta Homes"],
    ["c-3", "Cedar Ltd"],
    ["c-4", "Delta Roofs"],
  ]),
  jobCustomer: new Map<string, string | null>([["job-9", "c-2"]]),
};

describe("population — window and statuses", () => {
  it("buckets by the LONDON day: 23:30Z on 31 July 2025 is 1 Aug London → inside", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ created_at: "2025-07-31T23:30:00Z" }), // London 2025-08-01 → in
        inv({ created_at: "2025-07-31T22:30:00Z" }), // London 2025-07-31 → out
      ],
      naming,
      window: WINDOW,
    });
    expect(c.invoiceCount).toBe(1);
    expect(c.totalRevenue).toBe(100);
  });

  it("excludes drafts (never issued — nothing was sold); unpaid still counts", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ status: "draft", amount: 999 }),
        inv({ status: "overdue", amount: 50 }),
        inv({ status: "paid", amount: 50 }),
      ],
      naming,
      window: WINDOW,
    });
    expect(c.invoiceCount).toBe(2);
    expect(c.totalRevenue).toBe(100);
  });

  it("falls back to the invoice's job for a pre-backfill row, else Unattributed", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ customer_id: null, job_id: "job-9", amount: 60 }), // → c-2 via job
        inv({ customer_id: null, job_id: "job-unknown", amount: 40 }), // → unattributed
      ],
      naming,
      window: WINDOW,
    });
    const beta = c.top.find((s) => s.customerId === "c-2");
    const unattributed = c.top.find((s) => s.customerId === null);
    expect(beta?.revenue).toBe(60);
    expect(unattributed?.name).toBe(UNATTRIBUTED_LABEL);
    expect(unattributed?.revenue).toBe(40); // reported, never dropped
  });
});

describe("the heuristic flag — thresholds verbatim, floored", () => {
  it("fires the top-1 rule strictly above 40%", () => {
    // c-1: 41, others: 59 spread across 4 more invoices → 5 invoices total.
    const c = computeCustomerConcentration({
      invoices: [
        inv({ customer_id: "c-1", amount: 41 }),
        inv({ customer_id: "c-2", amount: 15 }),
        inv({ customer_id: "c-3", amount: 15 }),
        inv({ customer_id: "c-4", amount: 15 }),
        inv({ customer_id: "c-2", amount: 14 }),
      ],
      naming,
      window: WINDOW,
    });
    expect(c.top1SharePct).toBe(41);
    expect(c.concentrated).toBe(true);
    expect(c.flaggedBecause).toContain(`above ${TOP1_CONCENTRATION_PCT}%`);
  });

  it("fires the top-3 rule above 70% when top-1 alone does not", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ customer_id: "c-1", amount: 30 }),
        inv({ customer_id: "c-2", amount: 25 }),
        inv({ customer_id: "c-3", amount: 20 }),
        inv({ customer_id: "c-4", amount: 25 }),
        inv({ customer_id: "c-4", amount: 0 }),
      ],
      naming,
      window: WINDOW,
    });
    expect(c.top1SharePct).toBe(30); // under the top-1 rule
    expect(c.top3SharePct).toBe(80); // 30 + 25 + 25 — over the top-3 rule
    expect(c.concentrated).toBe(true);
    expect(c.flaggedBecause).toContain(`above ${TOP3_CONCENTRATION_PCT}%`);
  });

  it("boundary: exactly AT the thresholds does not fire (strictly-above rules)", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ customer_id: "c-1", amount: 40 }),
        inv({ customer_id: "c-2", amount: 15 }),
        inv({ customer_id: "c-3", amount: 15 }),
        inv({ customer_id: "c-4", amount: 15 }),
        inv({ customer_id: null, job_id: null, amount: 15 }),
      ],
      naming,
      window: WINDOW,
    });
    expect(c.top1SharePct).toBe(40);
    expect(c.top3SharePct).toBe(70);
    expect(c.concentrated).toBe(false);
    expect(c.flaggedBecause).toBeNull();
  });

  it("withholds the verdict below the invoice floor", () => {
    const c = computeCustomerConcentration({
      invoices: [
        inv({ customer_id: "c-1", amount: 100 }),
        inv({ customer_id: "c-1", amount: 100 }),
      ],
      naming,
      window: WINDOW,
    });
    expect(c.invoiceCount).toBeLessThan(MIN_CONCENTRATION_INVOICES);
    expect(c.top1SharePct).toBe(100); // the share is shown…
    expect(c.concentrated).toBeNull(); // …the verdict is withheld
    const flag = concentrationFlagMetric(c);
    expect(flag.provenance.sampleFloorApplied).toBe(true);
  });
});

describe("provenance", () => {
  const c = computeCustomerConcentration({ invoices: [], naming, window: WINDOW });

  it("shares are derived; the flag is heuristic with thresholds stated verbatim", () => {
    expect(concentrationSharesMetric(c).provenance.kind).toBe("derived");
    const flag = concentrationFlagMetric(c);
    expect(flag.provenance.kind).toBe("heuristic");
    expect(flag.provenance.basis).toContain(`${TOP1_CONCENTRATION_PCT}%`);
    expect(flag.provenance.basis).toContain(`${TOP3_CONCENTRATION_PCT}%`);
    expect(flag.provenance.basis).toContain(`${MIN_CONCENTRATION_INVOICES} invoices`);
  });
});
