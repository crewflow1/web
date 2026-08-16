import { describe, it, expect } from "vitest";
import {
  computeCustomerLtvForecast,
  customerLtvForecastMetric,
  MIN_ORDERS_FOR_FORECAST,
  type LtvForecastInvoice,
  type LtvForecastActivity,
} from "@/lib/health/customer-ltv-forecast";

/**
 * CUSTOMER LTV FORECAST — exact values from fixtures. A deterministic ESTIMATE:
 * projection = avg order value × orders/yr × horizon; churn is recency measured
 * against the customer's own median cadence. Thin history withholds a number
 * (never fabricates one); a lapsed customer's projection is withheld; jobs pull
 * recency forward without touching the value maths.
 */

const TODAY = "2026-08-16";

const naming = {
  customerName: new Map([
    ["c1", "Acme Builders"],
    ["c2", "Brightwork Ltd"],
    ["c3", "Old Client Co"],
    ["c4", "One-Off Ltd"],
    ["c5", "Recent Job Ltd"],
    ["cf", "Floor Trades"],
  ]),
  jobCustomer: new Map<string, string | null>([["j-c2", "c2"]]),
};

function inv(o: Partial<LtvForecastInvoice> & { status: string; issuedAt: string | null }): LtvForecastInvoice {
  return { amount: null, customer_id: null, job_id: null, ...o };
}

function build(invoices: LtvForecastInvoice[], activity: LtvForecastActivity[] = []) {
  return computeCustomerLtvForecast({ invoices, activity, naming, todayKey: TODAY });
}

describe("computeCustomerLtvForecast — projection math", () => {
  it("projects avg order value × orders/yr × horizon, with every factor shown", () => {
    const f = build([
      inv({ status: "sent", amount: 1000, customer_id: "c1", issuedAt: "2026-01-01T12:00:00Z" }),
      inv({ status: "paid", amount: 2000, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1500, customer_id: "c1", issuedAt: "2026-07-01T12:00:00Z" }),
    ]);
    const c1 = f.customers.find((c) => c.customerId === "c1")!;
    expect(c1.orderCount).toBe(3);
    expect(c1.distinctOrderDays).toBe(3);
    expect(c1.avgOrderValue).toBe(1500); // (1000+2000+1500)/3
    expect(c1.medianCadenceDays).toBe(90.5); // median of [90, 91]
    expect(c1.ordersPerYear).toBe(4.04); // 365.25 / 90.5
    expect(c1.daysSinceLastActivity).toBe(46); // 2026-07-01 → 2026-08-16
    expect(c1.recencyRatio).toBe(0.51); // 46 / 90.5
    expect(c1.churn).toBe("active");
    expect(c1.projectedHorizonValue).toBe(6060); // 1500 × 4.04 × 1
    expect(c1.projectable).toBe(true);
    expect(f.horizonMonths).toBe(12);
    expect(f.sufficient).toBe(true);
    expect(f.projectedTotal).toBe(6060);
  });

  it("counts orders separately from distinct order days (same-day invoices)", () => {
    const f = build([
      inv({ status: "paid", amount: 100, customer_id: "c1", issuedAt: "2026-03-01T12:00:00Z" }),
      inv({ status: "paid", amount: 300, customer_id: "c1", issuedAt: "2026-03-01T15:00:00Z" }),
      inv({ status: "sent", amount: 200, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
    ]);
    const c1 = f.customers.find((c) => c.customerId === "c1")!;
    expect(c1.orderCount).toBe(3);
    expect(c1.distinctOrderDays).toBe(2); // 2026-03-01 collapses
    expect(c1.avgOrderValue).toBe(200); // (100+300+200)/3
    expect(c1.medianCadenceDays).toBe(31); // Mar 1 → Apr 1
  });

  it("respects a custom horizon", () => {
    const f = computeCustomerLtvForecast({
      invoices: [
        inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
        inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-07-01T12:00:00Z" }),
      ],
      activity: [],
      naming,
      todayKey: TODAY,
      horizonMonths: 6,
    });
    const c1 = f.customers.find((c) => c.customerId === "c1")!;
    // cadence 91 (Apr1→Jul1), ordersPerYear = 365.25/91 = 4.01, × 1000 × 0.5
    expect(c1.medianCadenceDays).toBe(91);
    expect(c1.ordersPerYear).toBe(4.01);
    expect(c1.projectedHorizonValue).toBe(2005); // 1000 × 4.01 × 0.5
    expect(f.horizonMonths).toBe(6);
  });
});

describe("computeCustomerLtvForecast — churn / at-risk signal", () => {
  it("flags at-risk when recency exceeds ~1.5× the customer's cadence", () => {
    const f = build([
      inv({ status: "paid", amount: 500, customer_id: "c2", issuedAt: "2026-05-01T12:00:00Z" }),
      inv({ status: "paid", amount: 500, customer_id: "c2", issuedAt: "2026-06-01T12:00:00Z" }),
    ]);
    const c2 = f.customers.find((c) => c.customerId === "c2")!;
    expect(c2.medianCadenceDays).toBe(31); // May 1 → Jun 1
    expect(c2.daysSinceLastActivity).toBe(76); // Jun 1 → Aug 16
    expect(c2.recencyRatio).toBe(2.45); // 76 / 31
    expect(c2.churn).toBe("at_risk");
    expect(c2.projectable).toBe(true); // at-risk still projects
    expect(c2.projectedHorizonValue).toBe(5890); // 500 × 11.78 (365.25/31)
    expect(f.atRiskCount).toBe(1);
    expect(f.atRisk.map((c) => c.customerId)).toContain("c2");
  });

  it("marks a customer LAPSED and WITHHOLDS the projection (never straight-lines a dead account)", () => {
    const f = build([
      inv({ status: "paid", amount: 800, customer_id: "c3", issuedAt: "2026-01-01T12:00:00Z" }),
      inv({ status: "paid", amount: 800, customer_id: "c3", issuedAt: "2026-01-15T12:00:00Z" }),
    ]);
    const c3 = f.customers.find((c) => c.customerId === "c3")!;
    expect(c3.medianCadenceDays).toBe(14);
    expect(c3.churn).toBe("lapsed"); // 200+ days since / 14 ≫ 3×
    expect(c3.projectedHorizonValue).toBeNull();
    expect(c3.projectable).toBe(false);
    expect(f.lapsedCount).toBe(1);
    expect(f.projectedTotal).toBe(0); // withheld projection contributes nothing
    expect(f.sufficient).toBe(false); // no projectable customer
    expect(f.atRisk.map((c) => c.customerId)).toContain("c3"); // still on the worklist
  });

  it("the absolute floor keeps a short-cadence customer active until MIN_AT_RISK_DAYS pass", () => {
    // cadence 20d, 40d since last: ratio 2.0 (> 1.5×) but only 40 days have passed.
    const f = build([
      inv({ status: "paid", amount: 100, customer_id: "cf", issuedAt: "2026-06-17T12:00:00Z" }),
      inv({ status: "paid", amount: 100, customer_id: "cf", issuedAt: "2026-07-07T12:00:00Z" }),
    ]);
    const cf = f.customers.find((c) => c.customerId === "cf")!;
    expect(cf.medianCadenceDays).toBe(20);
    expect(cf.daysSinceLastActivity).toBe(40);
    expect(cf.recencyRatio).toBe(2); // > 1.5 …
    expect(cf.churn).toBe("active"); // … but < 45 days, so the floor holds
  });

  it("a recent JOB pulls recency forward without touching the value maths", () => {
    const invoices = [
      inv({ status: "paid", amount: 1000, customer_id: "c5", issuedAt: "2026-01-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1000, customer_id: "c5", issuedAt: "2026-02-01T12:00:00Z" }),
    ];
    const withoutJob = build(invoices);
    expect(withoutJob.customers.find((c) => c.customerId === "c5")!.churn).toBe("lapsed");

    const withJob = build(invoices, [{ customerId: "c5", at: "2026-08-10T12:00:00Z" }]);
    const c5 = withJob.customers.find((c) => c.customerId === "c5")!;
    expect(c5.lastActivityDay).toBe("2026-08-10");
    expect(c5.daysSinceLastActivity).toBe(6);
    expect(c5.churn).toBe("active");
    expect(c5.avgOrderValue).toBe(1000); // unchanged by the job
    expect(c5.medianCadenceDays).toBe(31); // Jan 1 → Feb 1, unchanged
  });
});

describe("computeCustomerLtvForecast — insufficient data & exclusions", () => {
  it("withholds everything for a customer with fewer than the minimum distinct order days", () => {
    expect(MIN_ORDERS_FOR_FORECAST).toBe(2);
    const f = build([
      inv({ status: "paid", amount: 9999, customer_id: "c4", issuedAt: "2026-08-01T12:00:00Z" }),
    ]);
    const c4 = f.customers.find((c) => c.customerId === "c4")!;
    expect(c4.distinctOrderDays).toBe(1);
    expect(c4.medianCadenceDays).toBeNull();
    expect(c4.ordersPerYear).toBeNull();
    expect(c4.projectedHorizonValue).toBeNull();
    expect(c4.churn).toBe("insufficient");
    expect(c4.projectable).toBe(false);
    expect(f.customersConsidered).toBe(1);
    expect(f.customersProjected).toBe(0);
    expect(f.sufficient).toBe(false);
  });

  it("excludes DRAFT invoices — a draft is not an order", () => {
    const f = build([
      inv({ status: "draft", amount: 9999, customer_id: "c1", issuedAt: "2026-01-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-07-01T12:00:00Z" }),
    ]);
    const c1 = f.customers.find((c) => c.customerId === "c1")!;
    expect(c1.orderCount).toBe(2); // the draft never counts
    expect(c1.avgOrderValue).toBe(1000);
    expect(f.invoiceCount).toBe(2);
  });

  it("excludes an undated issued invoice (no cadence/recency can be drawn from it)", () => {
    const f = build([
      inv({ status: "paid", amount: 500, customer_id: "c1", issuedAt: null }),
      inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1000, customer_id: "c1", issuedAt: "2026-07-01T12:00:00Z" }),
    ]);
    const c1 = f.customers.find((c) => c.customerId === "c1")!;
    expect(c1.orderCount).toBe(2); // the undated one is skipped
  });

  it("falls back to the job's customer when customer_id is null", () => {
    const f = build([
      inv({ status: "paid", amount: 400, customer_id: null, job_id: "j-c2", issuedAt: "2026-05-01T12:00:00Z" }),
      inv({ status: "paid", amount: 600, customer_id: null, job_id: "j-c2", issuedAt: "2026-06-01T12:00:00Z" }),
    ]);
    const c2 = f.customers.find((c) => c.customerId === "c2")!;
    expect(c2).toBeDefined();
    expect(c2.name).toBe("Brightwork Ltd");
    expect(c2.avgOrderValue).toBe(500);
  });

  it("excludes unattributable invoices — an unknown customer cannot be forecast", () => {
    const f = build([
      inv({ status: "paid", amount: 300, customer_id: null, job_id: null, issuedAt: "2026-05-01T12:00:00Z" }),
      inv({ status: "sent", amount: 200, customer_id: null, job_id: "unknown-job", issuedAt: "2026-06-01T12:00:00Z" }),
    ]);
    expect(f.customers).toHaveLength(0);
    expect(f.invoiceCount).toBe(0);
    expect(f.sufficient).toBe(false);
  });
});

describe("computeCustomerLtvForecast — ordering & labelling", () => {
  it("orders top by projected value (biggest first); withheld rows sink to the bottom", () => {
    const f = build([
      // c1 → projects 6060
      inv({ status: "sent", amount: 1000, customer_id: "c1", issuedAt: "2026-01-01T12:00:00Z" }),
      inv({ status: "paid", amount: 2000, customer_id: "c1", issuedAt: "2026-04-01T12:00:00Z" }),
      inv({ status: "paid", amount: 1500, customer_id: "c1", issuedAt: "2026-07-01T12:00:00Z" }),
      // c2 → projects 5890 (at-risk but still projected)
      inv({ status: "paid", amount: 500, customer_id: "c2", issuedAt: "2026-05-01T12:00:00Z" }),
      inv({ status: "paid", amount: 500, customer_id: "c2", issuedAt: "2026-06-01T12:00:00Z" }),
      // c4 → insufficient, no projection
      inv({ status: "paid", amount: 9999, customer_id: "c4", issuedAt: "2026-08-01T12:00:00Z" }),
    ]);
    expect(f.top.map((c) => c.customerId)).toEqual(["c1", "c2"]);
    expect(f.customers[f.customers.length - 1]!.customerId).toBe("c4"); // withheld sinks
    expect(f.projectedTotal).toBe(6060 + 5890);
  });

  it("emits a HEURISTIC, well-formed labelled metric that self-labels as an estimate", () => {
    const f = build([]);
    const m = customerLtvForecastMetric(f);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toContain("ESTIMATE");
    expect(m.provenance.basis.toLowerCase()).toContain("no blended score");
    expect(m.provenance.computedFrom.length).toBeGreaterThan(0);
  });
});
