import { describe, it, expect } from "vitest";
import {
  BRIEFING_ITEM_KEYS,
  composeBriefing,
  isDismissibleBriefingKey,
  type BriefingInput,
} from "@/lib/briefing/compose";

/**
 * The three fleet lines in the Daily Briefing.
 *
 * The severity contract is the thing under test: `critical` fires only for a
 * vehicle being driven without valid MOT or insurance, that line cannot be
 * snoozed, and nothing else in the fleet lane may reach the critical band.
 */

function base(overrides: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: new Date("2026-07-28T09:00:00Z"),
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

const FLEET_KEYS = [
  "fleet_legal_breach",
  "fleet_compliance_overdue",
  "fleet_compliance_due_soon",
] as const;

describe("fleet briefing signals", () => {
  it("emits nothing when the fleet is compliant", () => {
    expect(composeBriefing(base())).toEqual([]);
  });

  it("raises a CRITICAL, safety-category line for an in-service legal breach", () => {
    const items = composeBriefing(
      base({
        fleetCompliance: {
          legalBreach: { count: 2, vehicleCount: 2, maxDaysOverdue: 14 },
          otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
        },
      }),
    );
    const item = items.find((i) => i.key === "fleet_legal_breach");
    expect(item).toBeDefined();
    expect(item!.severity).toBe("critical");
    expect(item!.category).toBe("safety");
    expect(item!.count).toBe(2);
    expect(item!.href).toBe("/fleet/compliance");
    expect(item!.detail).toMatch(/offence/i);
  });

  it("counts VEHICLES, not obligations, in the breach headline", () => {
    const items = composeBriefing(
      base({
        fleetCompliance: {
          // one van with both MOT and insurance expired
          legalBreach: { count: 2, vehicleCount: 1, maxDaysOverdue: 3 },
          otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
        },
      }),
    );
    const item = items.find((i) => i.key === "fleet_legal_breach")!;
    expect(item.title).toMatch(/^1 in-service vehicle\b/);
    expect(item.count).toBe(1);
  });

  it("never lets a non-breach fleet line reach critical", () => {
    const items = composeBriefing(
      base({
        fleetCompliance: {
          legalBreach: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          otherOverdue: { count: 5, vehicleCount: 3, maxDaysOverdue: 200 },
          dueSoon: { count: 4, vehicleCount: 4, soonestDays: 0 },
        },
      }),
    );
    for (const i of items.filter((x) => FLEET_KEYS.includes(x.key as never))) {
      expect(i.severity).not.toBe("critical");
    }
    expect(items.find((i) => i.key === "fleet_compliance_overdue")!.severity).toBe("high");
  });

  it("grades upcoming renewals by proximity", () => {
    const soon = composeBriefing(
      base({
        fleetCompliance: {
          legalBreach: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          dueSoon: { count: 1, vehicleCount: 1, soonestDays: 3 },
        },
      }),
    ).find((i) => i.key === "fleet_compliance_due_soon")!;
    const later = composeBriefing(
      base({
        fleetCompliance: {
          legalBreach: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          dueSoon: { count: 1, vehicleCount: 1, soonestDays: 25 },
        },
      }),
    ).find((i) => i.key === "fleet_compliance_due_soon")!;
    expect(soon.severity).toBe("high");
    expect(later.severity).toBe("medium");
  });

  it("ranks a fleet legal breach above an overdue invoice, whatever the sum", () => {
    // Severity strictly dominates money in the composer's ranking.
    const items = composeBriefing(
      base({
        overdue: { count: 9, totalAmount: 250_000, maxDaysOverdue: 120 },
        fleetCompliance: {
          legalBreach: { count: 1, vehicleCount: 1, maxDaysOverdue: 1 },
          otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
          dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
        },
      }),
    );
    expect(items[0]!.key).toBe("fleet_legal_breach");
  });

  it("makes the legal breach NON-dismissible, like the permit and RAMS breaches", () => {
    expect(isDismissibleBriefingKey("fleet_legal_breach")).toBe(false);
    expect(isDismissibleBriefingKey("fleet_compliance_overdue")).toBe(true);
    expect(isDismissibleBriefingKey("fleet_compliance_due_soon")).toBe(true);
  });

  it("keeps the breach on the briefing even when the user dismissed it", () => {
    const items = composeBriefing(
      base({
        fleetCompliance: {
          legalBreach: { count: 1, vehicleCount: 1, maxDaysOverdue: 5 },
          otherOverdue: { count: 1, vehicleCount: 1, maxDaysOverdue: 5 },
          dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
        },
        dismissedKeys: new Set(["fleet_legal_breach", "fleet_compliance_overdue"]),
      }),
    );
    expect(items.map((i) => i.key)).toContain("fleet_legal_breach");
    expect(items.map((i) => i.key)).not.toContain("fleet_compliance_overdue");
  });

  it("registers every fleet key in the dismiss-action allowlist", () => {
    for (const k of FLEET_KEYS) {
      expect(BRIEFING_ITEM_KEYS as readonly string[]).toContain(k);
    }
  });
});
