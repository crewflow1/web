import { describe, it, expect } from "vitest";
import {
  computeOrgCashSummary,
  buildCashQueues,
  invoiceRemaining,
  type OrgCashInvoice,
} from "@/lib/commercial/org-cash";

const NOW = new Date("2026-07-26T09:00:00Z"); // week ends 2026-08-02, month ends 2026-07-31

const inv = (o: Partial<OrgCashInvoice>): OrgCashInvoice => ({
  id: o.id ?? "i",
  number: o.number ?? "INV-1",
  status: o.status ?? "sent",
  total: o.total ?? 0,
  due_date: o.due_date ?? null,
  paid: o.paid ?? 0,
  jobId: o.jobId ?? "j",
  jobLabel: o.jobLabel ?? "Smith",
});

describe("invoiceRemaining", () => {
  it("is total − paid, never negative", () => {
    expect(invoiceRemaining({ total: 10_000, paid: 6000 })).toBe(4000);
    expect(invoiceRemaining({ total: 5000, paid: 6000 })).toBe(0); // over-paid clamps
  });
});

describe("computeOrgCashSummary", () => {
  const invoices: OrgCashInvoice[] = [
    inv({ id: "a", status: "sent", total: 10_000, paid: 6000, due_date: "2026-07-01" }), // overdue, remaining 4000
    inv({ id: "b", status: "sent", total: 5000, paid: 0, due_date: "2026-07-30" }), // due this week + month
    inv({ id: "c", status: "sent", total: 3000, paid: 0, due_date: "2026-08-15" }), // later
    inv({ id: "d", status: "draft", total: 9999, paid: 0, due_date: "2026-07-02" }), // excluded (draft)
    inv({ id: "e", status: "paid", total: 2000, paid: 2000, due_date: "2026-07-02" }), // excluded (settled)
  ];

  it("aggregates the ledger, buckets by due date, and nets retention", () => {
    const s = computeOrgCashSummary({ invoices, retentionHeld: 1500, retentionDueNow: 0, readyToInvoice: 8000, now: NOW });
    expect(s.owedNow).toBe(12_000); // 4000 + 5000 + 3000
    expect(s.overdue).toBe(4000); // only the remaining on the overdue invoice, NOT its £10,000 total
    expect(s.dueThisWeek).toBe(5000);
    expect(s.dueThisMonth).toBe(5000);
    expect(s.collectableNow).toBe(10_500); // 12,000 − 1,500 retention
    expect(s.readyToInvoice).toBe(8000);
    expect(s.overdueCount).toBe(1);
    expect(s.invoiceCount).toBe(3);
  });

  it("never lets collectableNow go negative", () => {
    const s = computeOrgCashSummary({ invoices: [inv({ total: 1000, paid: 0, status: "sent" })], retentionHeld: 5000, retentionDueNow: 0, readyToInvoice: 0, now: NOW });
    expect(s.collectableNow).toBe(0);
  });

  it("an overdue invoice is not also counted as due-soon", () => {
    const s = computeOrgCashSummary({ invoices: [inv({ total: 1000, paid: 0, status: "sent", due_date: "2026-07-01" })], retentionHeld: 0, retentionDueNow: 0, readyToInvoice: 0, now: NOW });
    expect(s.overdue).toBe(1000);
    expect(s.dueThisWeek).toBe(0);
  });
});

describe("buildCashQueues", () => {
  it("splits overdue / due-soon / part-paid with correct remaining", () => {
    const q = buildCashQueues({
      invoices: [
        inv({ id: "a", status: "sent", total: 10_000, paid: 6000, due_date: "2026-07-01", number: "INV-A" }),
        inv({ id: "b", status: "sent", total: 5000, paid: 0, due_date: "2026-07-30", number: "INV-B" }),
      ],
      now: NOW,
    });
    expect(q.overdue.map((i) => i.id)).toEqual(["a"]);
    expect(q.overdue[0]!.remaining).toBe(4000);
    expect(q.overdue[0]!.daysOverdue).toBe(25);
    expect(q.dueSoon.map((i) => i.id)).toEqual(["b"]);
    expect(q.partPaid.map((i) => i.id)).toEqual(["a"]); // some paid, some remaining
  });
});
