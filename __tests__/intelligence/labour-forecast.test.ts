import { describe, it, expect } from "vitest";
import {
  computeLabourForecast,
  labourForecastMetric,
  STANDARD_WEEKLY_HOURS,
  type LabourMember,
  type LabourShift,
} from "@/lib/intelligence/labour-forecast";

/**
 * FORWARD LABOUR CAPACITY — deterministic weekly rostered-vs-capacity.
 *
 * Pins: exact hour apportionment (a shift split across a week boundary is
 * counted once), the stated-assumption capacity, overbooking, and the honesty
 * path (no members → insufficient; zero roster against real members is valid).
 */

const TODAY = "2026-08-14";
const MS_H = 3_600_000;

const ALICE: LabourMember = { userId: "u-alice", name: "Alice" };
const BOB: LabourMember = { userId: "u-bob", name: "Bob" };

/** A shift on a given UTC day at hours [h0,h1). */
function shift(userId: string, dayIso: string, h0: number, h1: number): LabourShift {
  const base = Date.parse(`${dayIso}T00:00:00Z`);
  return { userId, startMs: base + h0 * MS_H, endMs: base + h1 * MS_H };
}

describe("computeLabourForecast — rostered vs capacity", () => {
  const f = computeLabourForecast({
    todayKey: TODAY,
    horizonWeeks: 4,
    members: [ALICE, BOB],
    shifts: [
      shift("u-alice", "2026-08-18", 8, 16), // 8h, week 0
      shift("u-bob", "2026-08-19", 8, 16), // 8h, week 0
    ],
  });

  it("assumes the standard week for capacity and states the member count", () => {
    expect(f.sufficient).toBe(true);
    expect(f.standardWeeklyHours).toBe(STANDARD_WEEKLY_HOURS);
    expect(f.activeMemberCount).toBe(2);
    expect(f.weeks[0]!.capacityHours).toBe(2 * STANDARD_WEEKLY_HOURS);
  });

  it("sums rostered hours and computes utilisation and available capacity", () => {
    const w0 = f.weeks[0]!;
    expect(w0.rosteredHours).toBe(16);
    expect(w0.membersRostered).toBe(2);
    expect(w0.availableHours).toBe(2 * STANDARD_WEEKLY_HOURS - 16);
    expect(w0.utilisationPct).toBe(Math.round((16 / (2 * STANDARD_WEEKLY_HOURS)) * 100));
    expect(w0.overbooked).toBe(false);
  });

  it("carries a heuristic metric that prints the capacity assumption", () => {
    const m = labourForecastMetric(f);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toMatch(/assumption is stated/i);
  });
});

describe("computeLabourForecast — a shift spanning a week boundary is counted once", () => {
  it("splits the hours across weeks without double-counting", () => {
    const f = computeLabourForecast({
      todayKey: TODAY,
      horizonWeeks: 3,
      members: [ALICE],
      // 8h shift straddling the week0/week1 boundary (late 20 Aug into 21 Aug).
      shifts: [shift("u-alice", "2026-08-20", 20, 28)],
    });
    const total = f.weeks.reduce((s, w) => s + w.rosteredHours, 0);
    expect(total).toBeCloseTo(8, 5); // exactly 8h total, never 16
    expect(f.weeks[0]!.rosteredHours).toBeGreaterThan(0);
    expect(f.weeks[1]!.rosteredHours).toBeGreaterThan(0);
  });
});

describe("computeLabourForecast — overbooking", () => {
  it("flags weeks rostered beyond the assumed capacity", () => {
    const f = computeLabourForecast({
      todayKey: TODAY,
      horizonWeeks: 2,
      members: [ALICE], // capacity 40h/wk
      shifts: [shift("u-alice", "2026-08-17", 0, 50)], // 50h in week 0
    });
    const w0 = f.weeks[0]!;
    expect(w0.overbooked).toBe(true);
    expect(w0.availableHours).toBeLessThan(0);
    expect(f.anyOverbooked).toBe(true);
    expect(w0.utilisationPct!).toBeGreaterThan(100);
  });
});

describe("computeLabourForecast — insufficient (honesty path)", () => {
  it("reports insufficient with no members, but still lays out the weeks", () => {
    const f = computeLabourForecast({
      todayKey: TODAY,
      horizonWeeks: 3,
      members: [],
      shifts: [],
    });
    expect(f.sufficient).toBe(false);
    expect(f.weeks).toHaveLength(3);
    expect(f.weeks[0]!.capacityHours).toBe(0);
    expect(f.weeks[0]!.utilisationPct).toBeNull();
    expect(f.peakUtilisationPct).toBeNull();
  });

  it("treats zero roster against real members as valid (full capacity available)", () => {
    const f = computeLabourForecast({
      todayKey: TODAY,
      horizonWeeks: 2,
      members: [ALICE, BOB],
      shifts: [],
    });
    expect(f.sufficient).toBe(true);
    expect(f.totalRosteredHours).toBe(0);
    expect(f.weeks[0]!.availableHours).toBe(2 * STANDARD_WEEKLY_HOURS);
    expect(f.weeks[0]!.utilisationPct).toBe(0);
  });
});
