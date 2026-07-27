import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  cadenceToInterval,
  createScheduleSchema,
  cycleKey,
  intervalLabel,
  isDueForGeneration,
  isInspectionOverdue,
  isOneOff,
  nextDueAfter,
} from "@/lib/assets/inspection-schedule";

describe("cadence presets", () => {
  it("maps every preset to exactly-one interval (or one-off)", () => {
    expect(cadenceToInterval("one_off")).toEqual({ interval_days: null, interval_months: null });
    expect(cadenceToInterval("daily")).toEqual({ interval_days: 1, interval_months: null });
    expect(cadenceToInterval("weekly")).toEqual({ interval_days: 7, interval_months: null });
    expect(cadenceToInterval("six_weekly")).toEqual({ interval_days: 42, interval_months: null }); // O-licence PMI
    expect(cadenceToInterval("quarterly")).toEqual({ interval_days: null, interval_months: 3 });
    expect(cadenceToInterval("six_monthly")).toEqual({ interval_days: null, interval_months: 6 }); // LOLER accessories
    expect(cadenceToInterval("annual")).toEqual({ interval_days: null, interval_months: 12 });
    expect(cadenceToInterval("custom_days", 10)).toEqual({ interval_days: 10, interval_months: null });
  });

  it("labels intervals for the UI", () => {
    expect(intervalLabel({ interval_days: null, interval_months: null })).toBe("One-off");
    expect(intervalLabel({ interval_days: 42, interval_months: null })).toBe("Every 6 weeks");
    expect(intervalLabel({ interval_days: null, interval_months: 6 })).toBe("Every 6 months");
  });
});

describe("date-only arithmetic", () => {
  it("adds days across month/year boundaries", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01"); // non-leap
    expect(addDays("2028-02-27", 2)).toBe("2028-02-29"); // leap
  });

  it("adds months with month-end clamping", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28"); // clamp
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29"); // leap clamp
    expect(addMonths("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15"); // year wrap
  });

  it("nextDueAfter dispatches by interval kind; one-off has no next cycle", () => {
    expect(nextDueAfter("2026-07-20", { interval_days: 7, interval_months: null })).toBe("2026-07-27");
    expect(nextDueAfter("2026-07-20", { interval_days: null, interval_months: 6 })).toBe("2027-01-20");
    expect(nextDueAfter("2026-07-20", { interval_days: null, interval_months: null })).toBe("2026-07-20");
    expect(isOneOff({ interval_days: null, interval_months: null })).toBe(true);
  });
});

describe("generation window + overdue", () => {
  const base = { next_due: "2026-07-25", lead_time_days: 0, active: true };

  it("generates only inside today + lead window; paused never generates", () => {
    expect(isDueForGeneration(base, "2026-07-24")).toBe(false);
    expect(isDueForGeneration(base, "2026-07-25")).toBe(true); // on the day
    expect(isDueForGeneration({ ...base, lead_time_days: 7 }, "2026-07-19")).toBe(true); // lead window
    expect(isDueForGeneration({ ...base, active: false }, "2026-07-25")).toBe(false); // paused
    expect(isDueForGeneration(base, "2026-08-01")).toBe(true); // overdue still generates
  });

  it("cycleKey is the cycle's due date (deterministic)", () => {
    expect(cycleKey("2026-07-25")).toBe("2026-07-25");
  });

  it("isInspectionOverdue compares date-only", () => {
    expect(isInspectionOverdue("2026-07-19T00:00:00.000Z", "2026-07-20")).toBe(true);
    expect(isInspectionOverdue("2026-07-20T00:00:00.000Z", "2026-07-20")).toBe(false);
    expect(isInspectionOverdue(null, "2026-07-20")).toBe(false);
  });
});

describe("createScheduleSchema", () => {
  const base = {
    asset_id: "11111111-1111-1111-1111-111111111111",
    template_id: "22222222-2222-2222-2222-222222222222",
    cadence: "daily",
    next_due: "2026-07-21",
  };

  it("accepts a minimal schedule with defaults", () => {
    const parsed = createScheduleSchema.parse(base);
    expect(parsed.lead_time_days).toBe(0);
    expect(parsed.required_for_assignment).toBe(false);
  });

  it("requires custom_days for the custom cadence and a real ISO date", () => {
    expect(createScheduleSchema.safeParse({ ...base, cadence: "custom_days" }).success).toBe(false);
    expect(
      createScheduleSchema.safeParse({ ...base, cadence: "custom_days", custom_days: 42 }).success,
    ).toBe(true);
    expect(createScheduleSchema.safeParse({ ...base, next_due: "21/07/2026" }).success).toBe(false);
  });
});
