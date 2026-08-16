import { describe, it, expect } from "vitest";
import {
  BRIEFING_ITEM_KEYS,
  composeBriefing,
  isDismissibleBriefingKey,
  type BriefingInput,
} from "@/lib/briefing/compose";

/**
 * THREE-WAY MATCH — the Daily Briefing signal.
 *
 * The line is composed, never invented: server/services/po-matching.ts counts,
 * the composer words and ranks. The properties that matter:
 *
 *   IT DUPLICATES NOTHING — every other money line in the brief is money coming
 *                     IN (overdue invoices, retention, ready-to-invoice, cash
 *                     due, unscheduled value). This is the first money-OUT line.
 *   HONEST SEVERITY — capped at "high": being over-billed is money leaving that
 *                     shouldn't, but `critical` stays reserved for live safety
 *                     and legal exposure.
 *   ONE LINE        — over-billed, billed-not-received and the unbilled accrual
 *                     are one conversation ("go through the paperwork").
 *   NO DOUBLE COUNT — the headline is `moneyOutAtRisk`, taken as given. It is
 *                     NOT overBilled + billedNotReceived (usually the same
 *                     pounds twice) and the accrual is not in it at all.
 *   EXACT MONEY     — the rest of the brief rounds to whole pounds; this line
 *                     shows pence, because "no variance is hidden" is the
 *                     milestone's whole promise.
 *   SILENT BY DEFAULT — a company with no purchase orders, and a failed read,
 *                     both produce nothing rather than a false all-clear.
 */

type Variance = NonNullable<BriefingInput["supplierBillVariance"]>;

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

/** A variance rollup as server/services/po-matching.ts would hand it over. */
function variance(v: Partial<Variance> = {}): Variance {
  return {
    count: 1,
    moneyOutAtRisk: 0,
    overBilled: 0,
    billedNotReceived: 0,
    receivedNotBilled: 0,
    ...v,
  };
}

const only = (input: BriefingInput) => {
  const items = composeBriefing(input);
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe("supplier-bill variance briefing signal", () => {
  it("emits NOTHING when the field is absent — a PO-less org is silent", () => {
    expect(composeBriefing(base())).toEqual([]);
  });

  it("emits NOTHING when every order matches", () => {
    expect(composeBriefing(base({ supplierBillVariance: variance({ count: 0 }) }))).toEqual([]);
  });

  it("reports the money at risk when a supplier has over-billed", () => {
    const item = only(
      base({
        supplierBillVariance: variance({
          count: 3,
          moneyOutAtRisk: 2000,
          overBilled: 1200,
          billedNotReceived: 1400,
        }),
      }),
    );
    expect(item.key).toBe("supplier_bill_variance");
    expect(item.category).toBe("money");
    expect(item.severity).toBe("high");
    expect(item.amount).toBe(2000);
    expect(item.count).toBe(3);
    expect(item.href).toBe("/purchase-orders/matching");
    expect(item.title).toContain("£2,000");
    expect(item.detail).toContain("3 purchase orders");
  });

  it("takes moneyOutAtRisk AS GIVEN — it never adds the two per-kind figures", () => {
    // THE double-count guard. An order invoiced £120 above a FULLY DELIVERED
    // order is flagged as over-billed £120 AND billed-not-received £120: the same
    // pounds from two angles. The exposure is £120. Summing would say £240 and
    // send an owner into a supplier meeting with a number that does not exist.
    const item = only(
      base({
        supplierBillVariance: variance({
          moneyOutAtRisk: 120,
          overBilled: 120,
          billedNotReceived: 120,
        }),
      }),
    );
    expect(item.amount).toBe(120);
    expect(item.title).toContain("£120");
    expect(item.title).not.toContain("240");
  });

  it("never adds the accrual to the money at risk — nothing has been overpaid there", () => {
    const item = only(
      base({
        supplierBillVariance: variance({
          count: 2,
          moneyOutAtRisk: 500,
          overBilled: 500,
          receivedNotBilled: 9000, // huge, and deliberately NOT in `amount`
        }),
      }),
    );
    expect(item.amount).toBe(500);
    expect(item.title).toContain("£500");
    expect(item.title).not.toContain("9,000");
  });

  it("drops to MEDIUM when the only variance is an unbilled delivery", () => {
    // The cost is understated, which matters — but no money has gone out the
    // wrong way, so it must not shout as loudly as an over-billing.
    const item = only(
      base({ supplierBillVariance: variance({ receivedNotBilled: 4300 }) }),
    );
    expect(item.severity).toBe("medium");
    expect(item.amount).toBe(4300);
    expect(item.title).toBe("£4,300 delivered and not yet billed");
    expect(item.detail).toContain("cost is understated");
  });

  it("carries pence through without float drift", () => {
    const item = only(
      base({ supplierBillVariance: variance({ moneyOutAtRisk: 0.1 + 0.2, overBilled: 0.3 }) }),
    );
    expect(item.amount).toBe(0.3); // not 0.30000000000000004
    expect(item.title).toContain("£0.30");
  });

  it("shows whole pounds when there are no pence, like every other money line", () => {
    const item = only(
      base({ supplierBillVariance: variance({ moneyOutAtRisk: 2500, overBilled: 2500 }) }),
    );
    expect(item.title).toBe("£2,500 billed above what was ordered or delivered");
  });

  it("emits exactly ONE line, never one per kind", () => {
    const items = composeBriefing(
      base({
        supplierBillVariance: variance({
          count: 6,
          moneyOutAtRisk: 200,
          overBilled: 100,
          billedNotReceived: 200,
          receivedNotBilled: 300,
        }),
      }),
    );
    expect(items).toHaveLength(1);
  });

  it("is capped at high — it can never outrank a live safety breach", () => {
    const items = composeBriefing(
      base({
        activeJobsNoCurrentRams: 1,
        supplierBillVariance: variance({
          count: 40,
          moneyOutAtRisk: 250_000,
          overBilled: 250_000,
        }),
      }),
    );
    expect(items[0]?.key).toBe("jobs_without_rams");
    expect(items[1]?.key).toBe("supplier_bill_variance");
  });

  it("outranks the receivables lines it sits beside, on severity alone", () => {
    // The money-in lines are medium/low; money leaving the wrong way is high.
    const items = composeBriefing(
      base({
        overdue: { count: 1, totalAmount: 400, maxDaysOverdue: 3 },
        cashDueSoon: 80_000,
        supplierBillVariance: variance({ moneyOutAtRisk: 60, overBilled: 60 }),
      }),
    );
    expect(items[0]?.key).toBe("supplier_bill_variance");
  });

  it("is in the dismiss allowlist and IS dismissible", () => {
    // Not a safety breach, so a builder may snooze it for a day; the queue and
    // the register link stay there either way.
    expect(BRIEFING_ITEM_KEYS).toContain("supplier_bill_variance");
    expect(isDismissibleBriefingKey("supplier_bill_variance")).toBe(true);
  });

  it("honours a dismissal for the day", () => {
    const items = composeBriefing(
      base({
        dismissedKeys: new Set(["supplier_bill_variance"]),
        supplierBillVariance: variance({ moneyOutAtRisk: 1000, overBilled: 1000 }),
      }),
    );
    expect(items).toEqual([]);
  });

  it("does not duplicate any existing money key", () => {
    // The guard against the failure mode the brief asked about: a second line
    // saying the same thing as one already there. Every money key that existed
    // before this milestone is money COMING IN.
    const moneyIn = [
      "overdue_invoices",
      "retention_due",
      "billing_ready",
      "cash_due_soon",
      "unscheduled_value",
    ];
    expect(moneyIn).not.toContain("supplier_bill_variance");
    // ...and no two keys in the allowlist collide.
    expect(new Set(BRIEFING_ITEM_KEYS).size).toBe(BRIEFING_ITEM_KEYS.length);
  });

  it("never tells the reader an amount is too small to bother with", () => {
    const item = only(
      base({ supplierBillVariance: variance({ moneyOutAtRisk: 0.01, overBilled: 0.01 }) }),
    );
    // A penny still earns a line, AND the penny is shown. The rest of the brief
    // formats money in whole pounds; here that would print "£0" and quietly
    // break the whole promise of the milestone.
    expect(item.severity).toBe("high");
    expect(item.title).toBe("£0.01 billed above what was ordered or delivered");
    expect(item.detail).toContain("£0.01");
    for (const word of ["tolerance", "acceptable", "negligible", "ignore"]) {
      expect(`${item.title} ${item.detail}`.toLowerCase()).not.toContain(word);
    }
  });
});
