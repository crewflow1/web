import { describe, expect, it } from "vitest";
import { buildPortalActionItems, money } from "@/lib/customers/portal-actions";

const TODAY = "2026-07-20";
const TOKEN = "11111111-1111-4111-8111-111111111111";

describe("money", () => {
  it("formats GBP with pennies", () => {
    expect(money(2400)).toBe("£2,400.00");
    expect(money("850.5")).toBe("£850.50");
    expect(money(null)).toBe("£0.00");
  });
});

describe("buildPortalActionItems", () => {
  it("orders: overdue payments → quotes (soonest expiry) → due payments → decisions", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [
        { id: "q2", number: "Q-0002", status: "sent", total: 900, valid_until: "2026-08-30", public_token: "pt2" },
        { id: "q1", number: "Q-0001", status: "viewed", total: 2400, valid_until: "2026-07-25", public_token: "pt1" },
        { id: "q3", number: "Q-0003", status: "accepted", total: 100, valid_until: null, public_token: "pt3" }, // not actionable
      ],
      invoices: [
        { id: "i1", number: "INV-0001", status: "sent", total: 5000, due_date: "2026-07-01" }, // overdue
        { id: "i2", number: "INV-0002", status: "sent", total: 1200, due_date: "2026-08-01" }, // due
      ],
      reports: [{ id: "r1", title: "Progress report #3", decisions_outstanding: true }],
    });

    expect(items.map((i) => i.kind)).toEqual([
      "invoice_overdue",
      "quote",
      "quote",
      "invoice_due",
      "report_decision",
    ]);
    // Precise financial labels, never generic CTAs.
    expect(items[0]!.label).toBe("Payment of £5,000.00 is overdue — invoice INV-0001");
    expect(items[1]!.label).toBe("Review and respond — £2,400.00 quote Q-0001"); // soonest expiry first
    expect(items[1]!.href).toBe("/q/pt1"); // the single-authority quote surface
    expect(items[1]!.sub).toContain("Valid until 2026-07-25");
    expect(items[3]!.sub).toBe("Due by 2026-08-01.");
    expect(items[4]!.href).toBe(`/customer-portal/${TOKEN}/reports/r1`);
  });

  it("returns empty for a customer with nothing outstanding", () => {
    expect(
      buildPortalActionItems({ token: TOKEN, todayIso: TODAY, quotes: [], invoices: [], reports: [] }),
    ).toHaveLength(0);
  });

  it("never surfaces drafts or quotes without a public token", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [
        { id: "q1", number: null, status: "draft", total: 100, valid_until: null, public_token: "pt" },
        { id: "q2", number: null, status: "sent", total: 100, valid_until: null, public_token: null },
      ],
      invoices: [],
      reports: [],
    });
    expect(items).toHaveLength(0);
  });

  // ── Class defect: the local overdue authority recognised only {overdue, sent},
  // so awaiting_payment / partially_paid invoices (the latter stamped by the
  // payment-sync trigger on ANY deposit) appeared in NEITHER list. These fixtures
  // FAIL on the pre-fix local-authority code and pass once every collectable
  // status spans overdue + due-soon, labelled NET of payments. ──────────────────

  it("a partially_paid PAST-DUE invoice APPEARS as overdue with the NET remaining label", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [],
      // £10k billed, £3k deposit received → owes £7k, past its due date.
      invoices: [
        { id: "i1", number: "INV-PP", status: "partially_paid", total: 10_000, due_date: "2026-07-01", paid: 3000 },
      ],
      reports: [],
    });
    expect(items.map((i) => i.kind)).toEqual(["invoice_overdue"]);
    // NET, not gross £10,000.00 — and never dropped from "Needs your attention".
    expect(items[0]!.label).toBe("Payment of £7,000.00 is overdue — invoice INV-PP");
  });

  it("an awaiting_payment PAST-DUE invoice APPEARS as overdue (not just {overdue,sent})", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [],
      invoices: [
        { id: "i1", number: "INV-AW", status: "awaiting_payment", total: 2000, due_date: "2026-07-10", paid: 0 },
      ],
      reports: [],
    });
    expect(items.map((i) => i.kind)).toEqual(["invoice_overdue"]);
    expect(items[0]!.label).toBe("Payment of £2,000.00 is overdue — invoice INV-AW");
  });

  it("a partially_paid NOT-yet-due invoice APPEARS as due-soon with the NET remaining label", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [],
      // £5k billed, £1k paid → owes £4k, due in the future.
      invoices: [
        { id: "i1", number: "INV-DUE", status: "partially_paid", total: 5000, due_date: "2026-08-01", paid: 1000 },
      ],
      reports: [],
    });
    expect(items.map((i) => i.kind)).toEqual(["invoice_due"]);
    expect(items[0]!.label).toBe("Payment of £4,000.00 is due — invoice INV-DUE");
  });

  it("a fully-settled invoice still carrying a collectable status is NOT surfaced (no £0 item)", () => {
    const items = buildPortalActionItems({
      token: TOKEN,
      todayIso: TODAY,
      quotes: [],
      invoices: [
        { id: "i1", number: "INV-Z", status: "partially_paid", total: 4000, due_date: "2026-07-01", paid: 4000 },
      ],
      reports: [],
    });
    expect(items).toHaveLength(0);
  });
});
