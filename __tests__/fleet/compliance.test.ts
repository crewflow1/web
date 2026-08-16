import { describe, it, expect } from "vitest";
import {
  assessCompliance,
  classifyDue,
  complianceSeverity,
  daysBetween,
  emptyComplianceRollup,
  isFleetComplianceType,
  rollupCompliance,
  type ComplianceScheduleInput,
} from "@/lib/fleet/compliance";

/**
 * Fleet compliance — the date maths and the severity rule.
 *
 * The boundary cases are the whole point: an MOT is valid THROUGH its expiry
 * date, so "due today" and "one day late" must land on different sides of the
 * line, and `critical` must fire only where a vehicle is actually being driven
 * illegally. Every assertion below is a date comparison with a right answer.
 */

const TODAY = "2026-07-28";

function schedule(over: Partial<ComplianceScheduleInput> = {}): ComplianceScheduleInput {
  return {
    id: "s1",
    assetId: "a1",
    type: "mot",
    nextDue: TODAY,
    active: true,
    leadTimeDays: 30,
    inService: true,
    ...over,
  };
}

describe("daysBetween", () => {
  it("counts whole calendar days forward and backward", () => {
    expect(daysBetween("2026-07-28", "2026-07-30")).toBe(2);
    expect(daysBetween("2026-07-28", "2026-07-26")).toBe(-2);
    expect(daysBetween("2026-07-28", "2026-07-28")).toBe(0);
  });

  it("is unaffected by the BST/GMT boundary (UTC-anchored)", () => {
    // 25 Oct 2026 is the UK clock change. A local-time implementation reports
    // 1.04 days here and rounds inconsistently; this must be exactly 1.
    expect(daysBetween("2026-10-24", "2026-10-25")).toBe(1);
    expect(daysBetween("2026-10-25", "2026-10-26")).toBe(1);
  });

  it("returns null rather than 0 for an unparseable date", () => {
    // A silent 0 would read as "due today" — the most dangerous wrong answer.
    expect(daysBetween(TODAY, "not-a-date")).toBeNull();
    expect(daysBetween("", TODAY)).toBeNull();
  });

  it("spans a year and a leap day correctly", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
    expect(daysBetween("2026-07-28", "2027-07-28")).toBe(365);
  });
});

describe("classifyDue — the expiry boundary", () => {
  it("treats the due date itself as DUE, never overdue", () => {
    // An MOT certificate is valid through its expiry date. Today is still legal.
    const r = classifyDue(TODAY, TODAY, 30);
    expect(r).toEqual({ state: "due_soon", daysUntilDue: 0 });
  });

  it("treats one day past as overdue", () => {
    const r = classifyDue("2026-07-27", TODAY, 30);
    expect(r).toEqual({ state: "overdue", daysUntilDue: -1 });
  });

  it("treats one day ahead as due soon inside the window", () => {
    expect(classifyDue("2026-07-29", TODAY, 30)?.state).toBe("due_soon");
  });

  it("is ok beyond the lead window, and due_soon exactly ON it", () => {
    expect(classifyDue("2026-08-27", TODAY, 30)?.state).toBe("due_soon"); // +30 = the edge
    expect(classifyDue("2026-08-28", TODAY, 30)?.state).toBe("ok"); // +31
  });

  it("with a zero lead time, only today is due_soon", () => {
    expect(classifyDue(TODAY, TODAY, 0)?.state).toBe("due_soon");
    expect(classifyDue("2026-07-29", TODAY, 0)?.state).toBe("ok");
  });

  it("treats a negative or non-finite lead time as zero rather than throwing", () => {
    expect(classifyDue("2026-07-29", TODAY, -5)?.state).toBe("ok");
    expect(classifyDue("2026-07-29", TODAY, Number.NaN)?.state).toBe("ok");
  });

  it("returns null on an unparseable due date", () => {
    expect(classifyDue("soon", TODAY, 30)).toBeNull();
  });
});

describe("complianceSeverity — critical is reserved for a live legal breach", () => {
  it("expired MOT on an IN-SERVICE vehicle is critical", () => {
    expect(complianceSeverity("mot", "overdue", -1, true)).toBe("critical");
  });

  it("expired insurance on an IN-SERVICE vehicle is critical", () => {
    expect(complianceSeverity("insurance", "overdue", -40, true)).toBe("critical");
  });

  it("expired MOT on an OFF-ROAD vehicle is high, NOT critical", () => {
    // An untested van on axle stands in the yard breaks no law. This carve-out
    // is what stops `critical` inflating into wallpaper.
    expect(complianceSeverity("mot", "overdue", -90, false)).toBe("high");
    expect(complianceSeverity("insurance", "overdue", -90, false)).toBe("high");
  });

  it("expired road tax is high even in service — an offence, but a different one", () => {
    expect(complianceSeverity("road_tax", "overdue", -10, true)).toBe("high");
  });

  it("an overdue service is never critical — it is not an offence", () => {
    expect(complianceSeverity("service", "overdue", -60, true)).toBe("high");
  });

  it("an overdue tyre check is high, never critical, even in service", () => {
    // The offence is the tread state, which a missed inspection date does not
    // prove; so a lapsed tyre check sits with road tax / service, not MOT.
    expect(complianceSeverity("tyres", "overdue", -60, true)).toBe("high");
    expect(complianceSeverity("tyres", "overdue", -60, false)).toBe("high");
  });

  it("upcoming renewals are graded by proximity and capped at high", () => {
    expect(complianceSeverity("mot", "due_soon", 0, true)).toBe("high");
    expect(complianceSeverity("mot", "due_soon", 7, true)).toBe("high");
    expect(complianceSeverity("mot", "due_soon", 8, true)).toBe("medium");
    expect(complianceSeverity("insurance", "due_soon", 29, true)).toBe("medium");
  });

  it("anything current is low", () => {
    expect(complianceSeverity("mot", "ok", 200, true)).toBe("low");
  });
});

describe("assessCompliance", () => {
  it("excludes inactive schedules entirely rather than calling them ok", () => {
    const out = assessCompliance([schedule({ active: false, nextDue: "2020-01-01" })], TODAY);
    expect(out).toHaveLength(0);
  });

  it("drops rows with an unparseable due date instead of guessing", () => {
    expect(assessCompliance([schedule({ nextDue: "whenever" })], TODAY)).toHaveLength(0);
  });

  it("sorts worst first: overdue before due_soon, most overdue first", () => {
    const out = assessCompliance(
      [
        schedule({ id: "soon", nextDue: "2026-08-05", type: "service" }),
        schedule({ id: "late", nextDue: "2026-07-01", type: "road_tax" }),
        schedule({ id: "later", nextDue: "2026-06-01", type: "mot" }),
      ],
      TODAY,
    );
    expect(out.map((o) => o.id)).toEqual(["later", "late", "soon"]);
  });

  it("breaks ties on id so the order is total and reproducible", () => {
    const out = assessCompliance(
      [
        schedule({ id: "bbb", nextDue: "2026-07-01" }),
        schedule({ id: "aaa", nextDue: "2026-07-01" }),
      ],
      TODAY,
    );
    expect(out.map((o) => o.id)).toEqual(["aaa", "bbb"]);
  });
});

describe("rollupCompliance", () => {
  it("separates the legal breach from everything else overdue", () => {
    const statuses = assessCompliance(
      [
        // in service, MOT 10 days expired → critical
        schedule({ id: "a", assetId: "v1", type: "mot", nextDue: "2026-07-18", inService: true }),
        // in service, tax 3 days expired → high, not a breach
        schedule({ id: "b", assetId: "v1", type: "road_tax", nextDue: "2026-07-25", inService: true }),
        // OFF ROAD, insurance long expired → high, not a breach
        schedule({ id: "c", assetId: "v2", type: "insurance", nextDue: "2026-01-01", inService: false }),
        // upcoming
        schedule({ id: "d", assetId: "v3", type: "service", nextDue: "2026-08-04", inService: true }),
      ],
      TODAY,
    );
    const r = rollupCompliance(statuses);

    expect(r.legalBreach).toEqual({ count: 1, vehicleCount: 1, maxDaysOverdue: 10 });
    expect(r.otherOverdue.count).toBe(2);
    expect(r.otherOverdue.vehicleCount).toBe(2); // v1 and v2
    // 1 Jan → 28 Jul 2026 (not a leap year): 181 days to 1 Jul, plus 27.
    expect(r.otherOverdue.maxDaysOverdue).toBe(208);
    expect(r.dueSoon).toEqual({ count: 1, vehicleCount: 1, soonestDays: 7 });
  });

  it("counts vehicles, not obligations, so one van with three lapses is one vehicle", () => {
    const statuses = assessCompliance(
      [
        schedule({ id: "a", assetId: "v1", type: "mot", nextDue: "2026-07-01" }),
        schedule({ id: "b", assetId: "v1", type: "insurance", nextDue: "2026-07-02" }),
      ],
      TODAY,
    );
    const r = rollupCompliance(statuses);
    expect(r.legalBreach.count).toBe(2);
    expect(r.legalBreach.vehicleCount).toBe(1);
  });

  it("an empty set rolls up to all zeroes, matching emptyComplianceRollup", () => {
    expect(rollupCompliance([])).toEqual(emptyComplianceRollup());
  });
});

describe("isFleetComplianceType", () => {
  it("accepts the five fleet obligations", () => {
    for (const t of ["mot", "insurance", "road_tax", "service", "tyres"]) {
      expect(isFleetComplianceType(t)).toBe(true);
    }
  });

  it("rejects the asset-generic maintenance types, so plant never lands on the fleet board", () => {
    for (const t of ["preventive", "calibration", "breakdown", "warranty", "corrective"]) {
      expect(isFleetComplianceType(t)).toBe(false);
    }
  });
});
