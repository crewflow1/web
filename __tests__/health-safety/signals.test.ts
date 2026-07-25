import { describe, expect, it } from "vitest";
import { buildHealthSafetySignals, type HsSnapshot } from "@/lib/health-safety/signals";

const zero: HsSnapshot = {
  ramsDraft: 0, ramsReviewOverdue: 0, permitsExpiringSoon: 0,
  permitsExpiredLive: 0, activeJobsNoCurrentRams: 0, highResidualRams: 0,
};

describe("buildHealthSafetySignals", () => {
  it("returns nothing when the org is all-clear", () => {
    expect(buildHealthSafetySignals(zero)).toEqual([]);
  });

  it("emits a signal per non-zero fact, danger first", () => {
    const signals = buildHealthSafetySignals({
      ...zero, ramsDraft: 2, permitsExpiredLive: 1, permitsExpiringSoon: 3,
    });
    expect(signals.map((s) => s.id)).toEqual(["permits-expired", "permits-expiring", "rams-draft"]);
    expect(signals[0]!.tone).toBe("danger");
    expect(signals[0]!.count).toBe(1);
  });

  it("orders danger → warn → info, then by count", () => {
    const signals = buildHealthSafetySignals({
      ramsDraft: 9, ramsReviewOverdue: 1, permitsExpiringSoon: 2,
      permitsExpiredLive: 5, activeJobsNoCurrentRams: 4, highResidualRams: 1,
    });
    const tones = signals.map((s) => s.tone);
    // every danger precedes every warn, every warn precedes every info
    expect(tones.indexOf("warn")).toBeGreaterThan(tones.lastIndexOf("danger"));
    expect(tones.indexOf("info")).toBeGreaterThan(tones.lastIndexOf("warn"));
    // within danger, higher count first (expired 5 before jobs-no-rams 4)
    expect(signals[0]!.id).toBe("permits-expired");
    expect(signals[1]!.id).toBe("jobs-no-rams");
  });

  it("pluralises correctly", () => {
    const one = buildHealthSafetySignals({ ...zero, permitsExpiredLive: 1 })[0]!;
    expect(one.title).toContain("1 permit ");
    const many = buildHealthSafetySignals({ ...zero, permitsExpiredLive: 3 })[0]!;
    expect(many.title).toContain("3 permits ");
  });

  it("every signal has a destination link", () => {
    const signals = buildHealthSafetySignals({
      ramsDraft: 1, ramsReviewOverdue: 1, permitsExpiringSoon: 1,
      permitsExpiredLive: 1, activeJobsNoCurrentRams: 1, highResidualRams: 1,
    });
    expect(signals).toHaveLength(6);
    for (const s of signals) expect(s.href).toMatch(/^\/health-safety/);
  });
});
