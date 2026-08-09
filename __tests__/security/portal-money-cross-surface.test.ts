import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computePortalPayments,
  type PortalInvoiceLite,
} from "@/lib/customers/portal-payments";

/**
 * CROSS-SURFACE MONEY CONSISTENCY — the customer portal HOME "Outstanding" tile
 * and the invoices-tab "Due now" tile must always agree, because they describe
 * the SAME fact (the balance this customer owes).
 *
 * The defect this pins:
 *   - DEFECT A: both surfaces read invoices with a flat `.limit()` (home 50,
 *     tab 200) and NO paging, so a >cap invoice history silently truncated the
 *     money aggregate.
 *   - DEFECT B: the HOME tile computed Outstanding as Σ GROSS total over
 *     {sent, overdue} only — it DROPPED `partially_paid` (and `awaiting_payment`)
 *     entirely and NEVER subtracted a payment. So a £10,000 invoice with £9,000
 *     paid showed £0 outstanding on the home page while the invoices tab (via
 *     computePortalPayments) showed £1,000. The two customer-facing surfaces
 *     contradicted each other.
 *
 * The fix unifies BOTH surfaces on ONE authority — computePortalPayments — over
 * a PAGED read. These assertions fail on the pre-fix code and pass after.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const OVERVIEW = read("app/customer-portal/[token]/page.tsx");
const LIST = read("app/customer-portal/[token]/invoices/page.tsx");

const li = (o: Partial<PortalInvoiceLite>): PortalInvoiceLite => ({
  status: o.status ?? "sent",
  total: o.total ?? 0,
  due_date: o.due_date ?? null,
  paid: o.paid ?? 0,
});

describe("portal money surfaces agree (home Outstanding == invoices Due now)", () => {
  it("BOTH surfaces route the customer balance through computePortalPayments (ONE authority)", () => {
    // The invoices tab already did; the home page must now too. Pre-fix, the home
    // page never imported/called computePortalPayments — this is RED then.
    expect(OVERVIEW).toMatch(/computePortalPayments/);
    expect(LIST).toMatch(/computePortalPayments/);
  });

  it("home no longer sums GROSS total over a {sent,overdue}-only filter (DEFECT B)", () => {
    // The exact pre-fix shape: filter to sent||overdue, then reduce over inv.total
    // (gross, no payment subtraction). Its return would mean partially_paid is
    // dropped and payments ignored — the source of the contradiction.
    expect(OVERVIEW).not.toMatch(
      /status === "sent" \|\| inv\.status === "overdue"[\s\S]*?\.reduce\(/,
    );
  });

  it("both surfaces PAGE the invoices read via fetchAllRows/.range, with NO flat .limit (DEFECT A)", () => {
    for (const src of [OVERVIEW, LIST]) {
      // The invoices read is windowed (paged), not capped.
      expect(src).toMatch(/\.from\("invoices"\)[\s\S]{0,500}?\.range\(/);
      expect(src).not.toMatch(/\.from\("invoices"\)[\s\S]{0,500}?\.limit\(/);
    }
    // The home page additionally pages its invoice_payments read (it did not read
    // payments at all before — that is why it could not net them).
    expect(OVERVIEW).toMatch(/\.from\("invoice_payments"\)[\s\S]{0,300}?\.range\(/);
  });

  it("keeps a LOUD read failure on every money read (a swallowed error must never render £0)", () => {
    expect(OVERVIEW).toMatch(/readFailure\("portal overview: invoices"/);
    expect(OVERVIEW).toMatch(/readFailure\("portal overview: payments"/);
    expect(LIST).toMatch(/readFailure\("portal invoices: invoices"/);
  });

  it("a £10k/£9k partially_paid invoice reads £1,000 on the ONE shared authority (both tiles)", () => {
    const invoices = [
      li({ status: "partially_paid", total: 10_000, paid: 9000, due_date: "2026-12-31" }),
    ];
    const now = new Date("2026-08-01T09:00:00Z");

    // The authority BOTH surfaces now call → £1,000 due, on both tiles.
    const summary = computePortalPayments(invoices, now);
    expect(summary.dueNow).toBe(1000);

    // The pre-fix HOME formula (DEFECT B) over the SAME invoice: partially_paid is
    // filtered out entirely, so it summed to £0 — contradicting the invoices tab.
    const preFixHomeOutstanding = invoices
      .filter((inv) => inv.status === "sent" || inv.status === "overdue")
      .reduce((s, inv) => s + Number(inv.total ?? 0), 0);
    expect(preFixHomeOutstanding).toBe(0);

    // The whole point: the old home number and the invoices-tab number DISAGREED.
    // On the unified authority they are identical.
    expect(preFixHomeOutstanding).not.toBe(summary.dueNow);
  });

  it("nets payments across a mixed set (paging correctness of the aggregate)", () => {
    const invoices = [
      li({ status: "partially_paid", total: 10_000, paid: 9000, due_date: "2026-12-31" }), // 1,000 due
      li({ status: "sent", total: 4000, paid: 0, due_date: "2026-12-31" }), // 4,000 due
      li({ status: "paid", total: 2000, paid: 2000, due_date: "2026-01-01" }), // settled
      li({ status: "awaiting_payment", total: 1500, paid: 500, due_date: "2026-12-31" }), // 1,000 due
      li({ status: "draft", total: 9999, paid: 0 }), // never issued
    ];
    const summary = computePortalPayments(invoices, new Date("2026-08-01T09:00:00Z"));
    expect(summary.paidToDate).toBe(11_500); // 9000 + 0 + 2000 + 500
    expect(summary.dueNow).toBe(6000); // 1000 + 4000 + 1000
  });
});
