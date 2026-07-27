import { describe, it, expect } from "vitest";
import {
  composeBriefing,
  isBriefingItemKey,
  isDismissibleBriefingKey,
  BRIEFING_ITEM_KEYS,
  type BriefingInput,
} from "@/lib/briefing/compose";

function base(overrides: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: new Date("2026-07-26T09:00:00Z"),
    overdue: { count: 0, totalAmount: 0, maxDaysOverdue: 0 },
    followUpQuotes: { count: 0, totalAmount: 0, oldestDaysStale: 0 },
    jobsTomorrowUnassigned: 0,
    permitsExpiredLive: 0,
    permitsExpiringSoon: 0,
    ramsReviewOverdue: 0,
    activeJobsNoCurrentRams: 0,
    toolboxAwaitingAck: 0,
    complianceExpiring: { count: 0, soonestDays: null },
    coldLeads: { count: 0, totalValue: 0 },
    retentionDue: { dueNow: 0, dueJobCount: 0 },
    readyToInvoice: { totalAmount: 0, jobCount: 0 },
    cashDueSoon: 0,
    unscheduled: { totalAmount: 0, jobCount: 0 },
    dismissedKeys: new Set(),
    ...overrides,
  };
}

describe("composeBriefing", () => {
  it("emits nothing when every signal is quiet", () => {
    expect(composeBriefing(base())).toEqual([]);
  });

  it("turns overdue invoices into a money item with the real £ figure, count and deadline", () => {
    const [item, ...rest] = composeBriefing(
      base({ overdue: { count: 3, totalAmount: 18_400, maxDaysOverdue: 21 } }),
    );
    expect(rest).toHaveLength(0);
    expect(item?.key).toBe("overdue_invoices");
    expect(item?.category).toBe("money");
    expect(item?.severity).toBe("high"); // >= £5,000
    expect(item?.title).toContain("£18,400");
    expect(item?.detail).toContain("3 invoices");
    expect(item?.detail).toContain("21 days");
    expect(item?.href).toBe("/invoices?status=overdue");
    expect(item?.amount).toBe(18_400);
  });

  it("keeps a small, recent overdue at medium severity", () => {
    const [item] = composeBriefing(base({ overdue: { count: 1, totalAmount: 400, maxDaysOverdue: 3 } }));
    expect(item?.severity).toBe("medium");
    expect(item?.detail).toContain("1 invoice"); // singular
  });

  it("ranks safety-critical above a high-value money item", () => {
    const items = composeBriefing(
      base({
        activeJobsNoCurrentRams: 1,
        overdue: { count: 5, totalAmount: 50_000, maxDaysOverdue: 60 },
      }),
    );
    expect(items[0]?.key).toBe("jobs_without_rams");
    expect(items[0]?.severity).toBe("critical");
    expect(items[1]?.key).toBe("overdue_invoices");
  });

  it("orders critical > high > medium across families", () => {
    const items = composeBriefing(
      base({
        permitsExpiredLive: 1, // critical
        permitsExpiringSoon: 1, // high
        toolboxAwaitingAck: 1, // medium
      }),
    );
    expect(items.map((i) => i.key)).toEqual([
      "permits_expired",
      "permits_expiring",
      "toolbox_awaiting_ack",
    ]);
  });

  it("emits at most one item per family and only allowlisted keys", () => {
    const items = composeBriefing(
      base({
        overdue: { count: 2, totalAmount: 3000, maxDaysOverdue: 10 },
        followUpQuotes: { count: 2, totalAmount: 9000, oldestDaysStale: 12 },
        jobsTomorrowUnassigned: 2,
        permitsExpiredLive: 1,
        ramsReviewOverdue: 1,
        complianceExpiring: { count: 2, soonestDays: 4 },
        coldLeads: { count: 3, totalValue: 20_000 },
        retentionDue: { dueNow: 8000, dueJobCount: 2 },
      }),
    );
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length); // no dupes
    for (const k of keys) expect(isBriefingItemKey(k)).toBe(true);
  });

  it("surfaces H2-CASH ready-to-invoice work as a money item linking to /cash", () => {
    const [item] = composeBriefing(base({ readyToInvoice: { totalAmount: 12_000, jobCount: 2 } }));
    expect(item?.key).toBe("billing_ready");
    expect(item?.category).toBe("money");
    expect(item?.href).toBe("/cash");
    expect(item?.title).toContain("£12,000");
    expect(item?.detail).toContain("2 jobs");
  });

  it("[M3] surfaces forward cash-due-soon as a LOW-severity money item to /cash", () => {
    const [item] = composeBriefing(base({ cashDueSoon: 18_000 }));
    expect(item?.key).toBe("cash_due_soon");
    expect(item?.category).toBe("money");
    expect(item?.severity).toBe("low");
    expect(item?.href).toBe("/cash");
    expect(item?.title).toContain("£18,000");
  });

  it("[M3] surfaces unscheduled contract value as a LOW-severity 'plan how to bill' nudge", () => {
    const [item] = composeBriefing(base({ unscheduled: { totalAmount: 42_000, jobCount: 3 } }));
    expect(item?.key).toBe("unscheduled_value");
    expect(item?.severity).toBe("low");
    expect(item?.title).toContain("£42,000");
    expect(item?.detail).toContain("3 jobs");
    expect(item?.href).toBe("/cash");
  });

  it("[M3] a huge forecast signal NEVER outranks a safety breach or overdue debt (severity dominates)", () => {
    const items = composeBriefing(
      base({
        activeJobsNoCurrentRams: 1, // critical safety
        overdue: { count: 1, totalAmount: 500, maxDaysOverdue: 2 }, // small overdue
        cashDueSoon: 250_000, // enormous forecast
        unscheduled: { totalAmount: 999_000, jobCount: 9 },
      }),
    );
    // Safety first, overdue second, forecast (low) strictly last — money weight
    // can never lift a low-severity item above a medium/high one.
    expect(items[0]?.key).toBe("jobs_without_rams");
    expect(items[1]?.key).toBe("overdue_invoices");
    const forecastKeys = items.filter((i) => i.key === "cash_due_soon" || i.key === "unscheduled_value");
    const forecastRanks = forecastKeys.map((i) => items.indexOf(i));
    expect(Math.min(...forecastRanks)).toBeGreaterThan(1); // both below safety + overdue
  });

  it("filters out items the user dismissed today", () => {
    const withOverdue = base({ overdue: { count: 1, totalAmount: 1000, maxDaysOverdue: 5 } });
    expect(composeBriefing(withOverdue)).toHaveLength(1);
    expect(
      composeBriefing({ ...withOverdue, dismissedKeys: new Set(["overdue_invoices"]) }),
    ).toHaveLength(0);
  });

  it("refuses to snooze a critical safety breach, but still filters non-critical dismissals", () => {
    const input = base({
      activeJobsNoCurrentRams: 2, // critical, non-dismissible
      permitsExpiredLive: 1, // critical, non-dismissible
      overdue: { count: 1, totalAmount: 1000, maxDaysOverdue: 5 }, // medium, dismissible
      dismissedKeys: new Set(["jobs_without_rams", "permits_expired", "overdue_invoices"]),
    });
    const keys = composeBriefing(input).map((i) => i.key);
    expect(keys).toContain("jobs_without_rams"); // cannot be dismissed
    expect(keys).toContain("permits_expired"); // cannot be dismissed
    expect(keys).not.toContain("overdue_invoices"); // dismissed as normal
    expect(isDismissibleBriefingKey("jobs_without_rams")).toBe(false);
    expect(isDismissibleBriefingKey("permits_expired")).toBe(false);
    expect(isDismissibleBriefingKey("overdue_invoices")).toBe(true);
  });

  it("is deterministic and order-stable for a given input", () => {
    const input = base({
      overdue: { count: 1, totalAmount: 6000, maxDaysOverdue: 40 },
      ramsReviewOverdue: 2,
      coldLeads: { count: 1, totalValue: 5000 },
    });
    const a = composeBriefing(input).map((i) => i.key);
    const b = composeBriefing(input).map((i) => i.key);
    expect(a).toEqual(b);
  });

  it("exposes exactly the keys the composer can produce", () => {
    expect(BRIEFING_ITEM_KEYS).toContain("overdue_invoices");
    expect(isBriefingItemKey("overdue_invoices")).toBe(true);
    expect(isBriefingItemKey("definitely_not_a_key")).toBe(false);
  });
});
