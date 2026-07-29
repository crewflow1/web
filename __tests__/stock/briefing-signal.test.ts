import { describe, it, expect } from "vitest";
import {
  BRIEFING_ITEM_KEYS,
  composeBriefing,
  isDismissibleBriefingKey,
  type BriefingInput,
} from "@/lib/briefing/compose";

/**
 * O3 OPERATIONAL STOCK — the Daily Briefing signal.
 *
 * The line is composed, never invented: `server/services/stock.ts` counts, the
 * composer words and ranks. The properties that matter:
 *
 *   HONEST SEVERITY — capped at "high", and only when something is at ZERO.
 *                     Running out stops a gang working today; it is not a
 *                     safety breach, and `critical` is reserved for those.
 *   ONE LINE        — out and low are the same conversation ("order this"), so
 *                     two rows in a five-row brief would be one too many.
 *   SILENT BY DEFAULT — an org that tracks no stock, and a failed read, both
 *                     produce nothing rather than a false all-clear.
 */

function base(overrides: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: new Date("2026-07-29T09:00:00Z"),
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

describe("low-stock briefing signal", () => {
  it("emits NOTHING when the field is absent — a stock-less org is silent", () => {
    expect(composeBriefing(base())).toEqual([]);
  });

  it("emits NOTHING when nothing is low or out", () => {
    expect(
      composeBriefing(base({ lowStock: { low: 0, out: 0, worstName: "Blocks" } })),
    ).toEqual([]);
  });

  it("low only → ONE 'medium' operations line naming the worst item", () => {
    const items = composeBriefing(
      base({ lowStock: { low: 3, out: 0, worstName: "Cement 25kg bag" } }),
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.key).toBe("stock_low");
    expect(item?.category).toBe("operations");
    expect(item?.severity).toBe("medium");
    expect(item?.title).toContain("3 stock items running low");
    expect(item?.detail).toContain("Cement 25kg bag");
    expect(item?.detail).toContain("reorder level");
    expect(item?.href).toBe("/stock");
    expect(item?.count).toBe(3);
  });

  it("anything at ZERO lifts it to 'high' — and never above", () => {
    const items = composeBriefing(
      base({ lowStock: { low: 2, out: 1, worstName: "Blocks" } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("high");
    expect(items[0]?.title).toContain("1 stock item at zero");
    expect(items[0]?.detail).toContain("2 more");
    expect(items[0]?.count).toBe(3);
  });

  it("NEVER reaches critical, however bad it gets", () => {
    const items = composeBriefing(
      base({ lowStock: { low: 500, out: 500, worstName: "Everything" } }),
    );
    expect(items[0]?.severity).toBe("high");
  });

  it("carries NO money — stock in this milestone has no value", () => {
    // The accounting boundary, asserted where a future contributor would be
    // most tempted to add "£X of stock below reorder level": there is no cost
    // column anywhere in the stock schema, so any figure here would be invented.
    const items = composeBriefing(base({ lowStock: { low: 1, out: 1, worstName: "Blocks" } }));
    expect(items[0]?.amount).toBeNull();
  });

  it("ranks BELOW a live safety breach and above nothing important", () => {
    const items = composeBriefing(
      base({
        activeJobsNoCurrentRams: 1,
        lowStock: { low: 0, out: 4, worstName: "Blocks" },
      }),
    );
    // Severity strictly dominates: a job running without a RAMS outranks an
    // empty shelf, whatever the counts.
    expect(items.map((i) => i.key)).toEqual(["jobs_without_rams", "stock_low"]);
  });

  it("is dismissible for the day — an empty shelf is not a legal exposure", () => {
    expect(isDismissibleBriefingKey("stock_low")).toBe(true);
    const input = base({ lowStock: { low: 1, out: 1, worstName: "Blocks" } });
    expect(composeBriefing({ ...input, dismissedKeys: new Set(["stock_low"]) })).toHaveLength(0);
  });

  it("is registered in the key allowlist the dismiss action validates against", () => {
    expect(BRIEFING_ITEM_KEYS as readonly string[]).toContain("stock_low");
  });

  it("says 'item' not 'items' for one", () => {
    const one = composeBriefing(base({ lowStock: { low: 1, out: 0, worstName: null } }));
    expect(one[0]?.title).toBe("1 stock item running low");
    // and copes with no name at all
    expect(one[0]?.detail).not.toContain("—");
  });
});
