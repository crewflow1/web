import { describe, it, expect } from "vitest";
import { computePortalPayments, type PortalInvoiceLite } from "@/lib/customers/portal-payments";

const NOW = new Date("2026-07-26T09:00:00Z");
const i = (o: Partial<PortalInvoiceLite>): PortalInvoiceLite => ({
  status: o.status ?? "sent",
  total: o.total ?? 0,
  due_date: o.due_date ?? null,
  paid: o.paid ?? 0,
});

describe("computePortalPayments (customer-safe)", () => {
  it("sums paid + outstanding across the customer's issued invoices", () => {
    const s = computePortalPayments(
      [
        i({ status: "partially_paid", total: 5000, paid: 3000, due_date: "2026-08-30" }), // £2,000 due
        i({ status: "paid", total: 4000, paid: 4000, due_date: "2026-07-01" }), // fully paid
        i({ status: "sent", total: 8000, paid: 0, due_date: "2026-07-10" }), // overdue £8,000
      ],
      NOW,
    );
    expect(s.paidToDate).toBe(7000); // 3000 + 4000
    expect(s.dueNow).toBe(10_000); // 2000 + 8000
    expect(s.overdue).toBe(8000); // only the past-due one
  });

  it("excludes draft invoices (never issued to the customer)", () => {
    const s = computePortalPayments([i({ status: "draft", total: 9999, paid: 0 })], NOW);
    expect(s).toEqual({ paidToDate: 0, dueNow: 0, overdue: 0 });
  });

  it("a part-paid invoice shows the REMAINING as due, not the full total", () => {
    const s = computePortalPayments([i({ status: "partially_paid", total: 10_000, paid: 6000, due_date: "2026-08-30" })], NOW);
    expect(s.dueNow).toBe(4000);
  });
});
