import { describe, it, expect } from "vitest";
import {
  BRIEFING_ITEM_KEYS,
  composeBriefing,
  isDismissibleBriefingKey,
  type BriefingInput,
} from "@/lib/briefing/compose";
import { computeCisHmrcDue } from "@/lib/commercial/cash-out";
import type { CisPaymentSnapshotRow } from "@/lib/cis/statements";

/**
 * H2-CASH M4 — the ONE money-OUT Daily Briefing signal.
 *
 * The money-out surface has six components. Exactly one of them earns a briefing
 * row, and this file pins BOTH halves of that judgement:
 *
 *   IT EARNS IT      — CIS withheld is a frozen ledger fact with a statutory
 *                      deadline and an HMRC penalty for missing it. One action.
 *   THE OTHERS DON'T — unpaid bills have no due date (a permanent line is
 *                      wallpaper); VAT and draft payroll are ESTIMATES; committed
 *                      spend is not a liability; and a negative net position is
 *                      the NORMAL state of a business that pays suppliers on 30
 *                      days and is paid on 60, so a line for it would fire on
 *                      healthy companies and teach people to ignore the brief.
 *
 * Severity is capped at "high" for the same reason every non-safety signal is:
 * `critical` belongs to live safety and legal breaches.
 */

function base(overrides: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: new Date("2026-07-30T09:00:00Z"),
    overdue: { count: 0, totalAmount: 0, maxDaysOverdue: 0 },
    followUpQuotes: { count: 0, totalAmount: 0, oldestDaysStale: 0 },
    jobsTomorrowUnassigned: 0,
    permitsExpiredLive: 0,
    permitsExpiringSoon: 0,
    ramsReviewOverdue: 0,
    activeJobsNoCurrentRams: 0,
    toolboxAwaitingAck: 0,
    complianceExpiring: { count: 0, soonestDays: null },
    staffQualifications: { expired: 0, expiring: { count: 0, soonestDays: null } },
    coldLeads: { count: 0, totalValue: 0 },
    retentionDue: { dueNow: 0, dueJobCount: 0 },
    readyToInvoice: { totalAmount: 0, jobCount: 0 },
    cashDueSoon: 0,
    unscheduled: { totalAmount: 0, jobCount: 0 },
    scheduleConflicts: {
      doubleBooked: { count: 0, soonestDays: null },
      leaveClashes: { count: 0, soonestDays: null },
      unassignedLater: { count: 0, soonestDays: null },
    },
    fleetCompliance: {
      legalBreach: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
      otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
      dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
    },
    dismissedKeys: new Set(),
    ...overrides,
  };
}

const only = (input: BriefingInput) => composeBriefing(input);
const item = (input: BriefingInput) => only(input).find((i) => i.key === "cis_due_hmrc");

describe("the CIS-to-HMRC briefing signal", () => {
  it("emits NOTHING when the field is absent — no subcontractors, or a read that failed", () => {
    expect(only(base())).toEqual([]);
  });

  it("emits nothing at zero — a nil liability is not news", () => {
    expect(item(base({ cisDueToHmrc: { amount: 0, dueInDays: 5, payBy: "2026-08-22" } }))).toBeUndefined();
  });

  it("emits nothing once the deadline has PASSED — CrewFlow can't know if you paid", () => {
    // Accusing a contractor of being late on the strength of data we do not hold
    // is worse than staying quiet. The /cash page reports the same money as
    // UNTRACKED for the identical reason.
    expect(item(base({ cisDueToHmrc: { amount: 4000, dueInDays: -3, payBy: "2026-06-22" } }))).toBeUndefined();
  });

  it("fires at HIGH within a week of the deadline, and says the date and the action", () => {
    const it7 = item(base({ cisDueToHmrc: { amount: 4200, dueInDays: 5, payBy: "2026-08-22" } }))!;
    expect(it7.severity).toBe("high");
    expect(it7.category).toBe("money");
    expect(it7.title).toMatch(/£4,200 CIS to pay HMRC/);
    expect(it7.detail).toMatch(/in 5 days/);
    expect(it7.detail).toMatch(/2026-08-22/);
    expect(it7.detail).toMatch(/by the 22nd/);
    expect(it7.detail, "the filing boundary must be explicit").toMatch(/doesn't file or pay for you/);
    expect(it7.href).toBe("/cis");
    expect(it7.amount).toBe(4200);
  });

  it("drops to MEDIUM further out, and never reaches critical", () => {
    expect(item(base({ cisDueToHmrc: { amount: 4200, dueInDays: 20, payBy: "2026-09-22" } }))!.severity).toBe("medium");
    // Capped: `critical` is reserved for live safety / legal breaches.
    for (const d of [0, 1, 5, 7, 14, 30]) {
      const row = item(base({ cisDueToHmrc: { amount: 99_999, dueInDays: d, payBy: "2026-08-22" } }))!;
      expect(row.severity, `${d} days out`).not.toBe("critical");
    }
  });

  it("words 'today' and 'tomorrow' rather than '0 days' / '1 days'", () => {
    expect(item(base({ cisDueToHmrc: { amount: 100, dueInDays: 0, payBy: "2026-08-22" } }))!.detail).toMatch(/due to HMRC today/);
    expect(item(base({ cisDueToHmrc: { amount: 100, dueInDays: 1, payBy: "2026-08-22" } }))!.detail).toMatch(/due to HMRC tomorrow/);
  });

  it("never outranks a safety breach, however large the liability", () => {
    const items = only(
      base({
        activeJobsNoCurrentRams: 1,
        cisDueToHmrc: { amount: 250_000, dueInDays: 0, payBy: "2026-08-22" },
      }),
    );
    expect(items[0]!.key).toBe("jobs_without_rams");
    expect(items.find((i) => i.key === "cis_due_hmrc")).toBeDefined();
  });

  it("is dismissible and is in the allowlist the dismiss action validates against", () => {
    expect(BRIEFING_ITEM_KEYS as readonly string[]).toContain("cis_due_hmrc");
    expect(isDismissibleBriefingKey("cis_due_hmrc")).toBe(true);
    const items = only(
      base({
        cisDueToHmrc: { amount: 4200, dueInDays: 3, payBy: "2026-08-22" },
        dismissedKeys: new Set(["cis_due_hmrc"]),
      }),
    );
    expect(items).toEqual([]);
  });

  it("is the ONLY money-out key — the other five components deliberately have none", () => {
    // An exact set, not a pattern: `billing_ready` contains "bill" but is a
    // money-IN line (work ready to invoice), so a regex would mis-accuse it.
    const forbidden = [
      "supplier_bills_due",
      "unpaid_bills",
      "payables_due",
      "vat_due",
      "payroll_due",
      "committed_spend",
      "cash_position_deficit",
      "net_position",
    ];
    for (const k of forbidden) {
      expect(
        BRIEFING_ITEM_KEYS as readonly string[],
        `${k} must not become a briefing line — see the cisDueToHmrc note in lib/briefing/compose.ts`,
      ).not.toContain(k);
    }
    // And exactly one money-out key exists today.
    const cisKeys = (BRIEFING_ITEM_KEYS as readonly string[]).filter((k) => k.startsWith("cis_"));
    expect(cisKeys).toEqual(["cis_due_hmrc"]);
  });

  it("does not duplicate an existing money signal — every money key is distinct", () => {
    const items = only(
      base({
        overdue: { count: 2, totalAmount: 8000, maxDaysOverdue: 40 },
        retentionDue: { dueNow: 6000, dueJobCount: 2 },
        readyToInvoice: { totalAmount: 9000, jobCount: 3 },
        cashDueSoon: 5000,
        unscheduled: { totalAmount: 7000, jobCount: 1 },
        cisDueToHmrc: { amount: 4200, dueInDays: 3, payBy: "2026-08-22" },
      }),
    );
    const moneyKeys = items.filter((i) => i.category === "money").map((i) => i.key);
    expect(new Set(moneyKeys).size).toBe(moneyKeys.length);
    expect(moneyKeys).toContain("cis_due_hmrc");
    // The money-IN lines are untouched by the addition.
    for (const k of ["overdue_invoices", "retention_due", "billing_ready", "cash_due_soon", "unscheduled_value"]) {
      expect(moneyKeys, `${k} must still fire`).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// The briefing and /cash must never disagree about the same money
// ---------------------------------------------------------------------------

describe("one definition of 'CIS due to HMRC'", () => {
  const snap = (o: { payment_id: string; tax_month_start: string; tax_month_end: string; cis_deduction: number; voided_at?: string | null }): CisPaymentSnapshotRow => ({
    payment_id: o.payment_id,
    supplier_id: "s1",
    paid_at: "2026-07-10",
    voided_at: o.voided_at ?? null,
    cis_status: "standard_20",
    deduction_rate: 20,
    verification_reference: null,
    legal_name: "Sub Ltd",
    utr_masked: null,
    cis_gross_payment: 5000,
    materials_total: 0,
    cis_deduction: o.cis_deduction,
    tax_month_start: o.tax_month_start,
    tax_month_end: o.tax_month_end,
  });

  it("computeCisHmrcDue is the shared authority the briefing signal is built from", () => {
    const rows = [
      snap({ payment_id: "p1", tax_month_start: "2026-07-06", tax_month_end: "2026-08-05", cis_deduction: 1200 }),
      snap({ payment_id: "p2", tax_month_start: "2026-05-06", tax_month_end: "2026-06-05", cis_deduction: 800 }),
    ];
    const due = computeCisHmrcDue(rows, "2026-07-30");
    expect(due.dueNow).toBe(1200);
    expect(due.dueOn).toBe("2026-08-22");
    expect(due.pastDeadline).toBe(800);

    // The briefing line carries EXACTLY that figure — not a re-sum.
    const row = item(base({ cisDueToHmrc: { amount: due.dueNow, dueInDays: 23, payBy: due.dueOn } }))!;
    expect(row.amount).toBe(due.dueNow);
  });

  it("a voided payment is not a liability on either surface", () => {
    const due = computeCisHmrcDue(
      [snap({ payment_id: "p1", tax_month_start: "2026-07-06", tax_month_end: "2026-08-05", cis_deduction: 1200, voided_at: "2026-07-20" })],
      "2026-07-30",
    );
    expect(due.dueNow).toBe(0);
    expect(due.pastDeadline).toBe(0);
    expect(item(base({ cisDueToHmrc: { amount: due.dueNow, dueInDays: 23, payBy: due.dueOn } }))).toBeUndefined();
  });
});
