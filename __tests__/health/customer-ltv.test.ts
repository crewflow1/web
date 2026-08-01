import { describe, it, expect } from "vitest";
import {
  computeCustomerLtv,
  customerLtvMetric,
  UNATTRIBUTED_LABEL,
  type LtvInvoice,
} from "@/lib/health/customer-ltv";

/**
 * CUSTOMER LTV — exact values from fixtures. Realised (paid) and committed
 * (issued-unpaid) are kept apart; drafts are never value; unresolved customers
 * land in Unattributed, never dropped.
 */

const naming = {
  customerName: new Map([
    ["c1", "Acme Builders"],
    ["c2", "Brightwork Ltd"],
  ]),
  jobCustomer: new Map<string, string | null>([["j-c2", "c2"]]),
};

function inv(o: Partial<LtvInvoice> & { id: string; status: string }): LtvInvoice {
  return { amount: null, customer_id: null, job_id: null, ...o };
}

describe("computeCustomerLtv", () => {
  it("splits realised (paid) from committed (issued-unpaid), ex-VAT, exactly", () => {
    const l = computeCustomerLtv({
      invoices: [
        inv({ id: "1", status: "paid", amount: 1000, customer_id: "c1" }),
        inv({ id: "2", status: "paid", amount: "500.50", customer_id: "c1" }),
        inv({ id: "3", status: "overdue", amount: 250, customer_id: "c1" }),
        inv({ id: "4", status: "sent", amount: 100, customer_id: "c1" }),
      ],
      naming,
    });
    const c1 = l.customers.find((c) => c.customerId === "c1")!;
    expect(c1.name).toBe("Acme Builders");
    expect(c1.realisedValue).toBe(1500.5);
    expect(c1.committedValue).toBe(350); // 250 overdue + 100 sent
    expect(c1.totalValue).toBe(1850.5);
    expect(c1.paidInvoiceCount).toBe(2);
    expect(c1.openInvoiceCount).toBe(2);
    expect(l.realisedTotal).toBe(1500.5);
    expect(l.committedTotal).toBe(350);
    expect(l.invoiceCount).toBe(4);
  });

  it("excludes DRAFT invoices entirely — a draft is not value", () => {
    const l = computeCustomerLtv({
      invoices: [
        inv({ id: "1", status: "draft", amount: 9999, customer_id: "c1" }),
        inv({ id: "2", status: "paid", amount: 100, customer_id: "c1" }),
      ],
      naming,
    });
    expect(l.realisedTotal).toBe(100);
    expect(l.committedTotal).toBe(0);
    expect(l.invoiceCount).toBe(1);
  });

  it("falls back to the job's customer when customer_id is null", () => {
    const l = computeCustomerLtv({
      invoices: [inv({ id: "1", status: "paid", amount: 800, customer_id: null, job_id: "j-c2" })],
      naming,
    });
    const c2 = l.customers.find((c) => c.customerId === "c2")!;
    expect(c2.name).toBe("Brightwork Ltd");
    expect(c2.realisedValue).toBe(800);
  });

  it("puts unresolvable invoices in the Unattributed bucket, never dropped", () => {
    const l = computeCustomerLtv({
      invoices: [
        inv({ id: "1", status: "paid", amount: 300, customer_id: null, job_id: null }),
        inv({ id: "2", status: "sent", amount: 200, customer_id: null, job_id: "unknown-job" }),
      ],
      naming,
    });
    const un = l.customers.find((c) => c.customerId === null)!;
    expect(un.name).toBe(UNATTRIBUTED_LABEL);
    expect(un.realisedValue).toBe(300);
    expect(un.committedValue).toBe(200);
    expect(l.customerCount).toBe(0); // unattributed is not a named customer
  });

  it("orders customers by total value, biggest first", () => {
    const l = computeCustomerLtv({
      invoices: [
        inv({ id: "1", status: "paid", amount: 100, customer_id: "c1" }),
        inv({ id: "2", status: "paid", amount: 900, customer_id: "c2" }),
      ],
      naming,
    });
    expect(l.top.map((c) => c.customerId)).toEqual(["c2", "c1"]);
  });

  it("emits a DERIVED, well-formed labelled metric", () => {
    const l = computeCustomerLtv({ invoices: [], naming });
    const m = customerLtvMetric(l);
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.basis).toContain("realised");
    expect(m.provenance.computedFrom.length).toBeGreaterThan(0);
  });
});
