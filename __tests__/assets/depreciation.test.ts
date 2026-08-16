import { describe, it, expect } from "vitest";
import {
  DEPRECIATION_METHODS,
  DEPRECIATION_METHOD_LABELS,
  computeNbv,
  depreciationSchedule,
  elapsedMonthsBetween,
  addMonths,
  round2,
  depreciationPolicySchema,
  friendlyDepreciationError,
  type DepreciationPolicy,
} from "@/lib/assets/depreciation";

describe("depreciation constants", () => {
  it("labels every method", () => {
    for (const m of DEPRECIATION_METHODS) expect(DEPRECIATION_METHOD_LABELS[m]).toBeTruthy();
  });
});

describe("elapsedMonthsBetween", () => {
  it("is zero at the start and before it", () => {
    expect(elapsedMonthsBetween("2024-01-01", "2024-01-01")).toBe(0);
    expect(elapsedMonthsBetween("2024-06-01", "2024-01-01")).toBe(0);
  });
  it("counts whole months exactly", () => {
    expect(elapsedMonthsBetween("2024-01-01", "2025-01-01")).toBe(12);
    expect(elapsedMonthsBetween("2024-01-15", "2024-02-15")).toBe(1);
    expect(elapsedMonthsBetween("2024-01-01", "2027-01-01")).toBe(36);
  });
  it("prorates the partial current month by day", () => {
    // 15 of Jan's 31 days elapsed.
    expect(elapsedMonthsBetween("2024-01-01", "2024-01-16")).toBeCloseTo(15 / 31, 6);
  });
});

describe("addMonths (month-end clamp)", () => {
  it("clamps 31 Jan + 1 month to end of Feb", () => {
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonths("2023-01-31", 1)).toBe("2023-02-28");
  });
  it("adds plain months", () => {
    expect(addMonths("2024-01-01", 12)).toBe("2025-01-01");
  });
});

describe("round2", () => {
  it("rounds to whole pence", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(9000 / 36)).toBe(250);
    expect(round2(10 / 3)).toBe(3.33);
  });
});

describe("computeNbv — straight line", () => {
  const p: DepreciationPolicy = {
    method: "straight_line",
    cost: 10000,
    salvage_value: 1000,
    start_date: "2024-01-01",
    useful_life_months: 36,
    annual_rate_pct: null,
  };

  it("starts at cost", () => {
    const r = computeNbv(p, "2024-01-01");
    expect(r.nbv).toBe(10000);
    expect(r.accumulatedDepreciation).toBe(0);
    expect(r.depreciableBase).toBe(9000);
    expect(r.fullyDepreciated).toBe(false);
  });

  it("depreciates linearly at £250/month", () => {
    expect(computeNbv(p, "2025-01-01").nbv).toBe(7000); // 12 * 250 = 3000
    expect(computeNbv(p, "2026-01-01").nbv).toBe(4000); // 24 * 250 = 6000
  });

  it("floors at salvage at end of life and never dips below", () => {
    const end = computeNbv(p, "2027-01-01"); // 36 months
    expect(end.nbv).toBe(1000);
    expect(end.fullyDepreciated).toBe(true);
    // Past useful life stays at salvage.
    expect(computeNbv(p, "2030-01-01").nbv).toBe(1000);
  });

  it("prorates a partial period", () => {
    // 0.5 month → 125 depreciation.
    const r = computeNbv({ ...p, start_date: "2024-01-01" }, "2024-01-16");
    expect(r.nbv).toBeCloseTo(10000 - 250 * (15 / 31), 2);
  });
});

describe("computeNbv — reducing balance", () => {
  const p: DepreciationPolicy = {
    method: "reducing_balance",
    cost: 10000,
    salvage_value: 0,
    start_date: "2024-01-01",
    useful_life_months: 60,
    annual_rate_pct: 25,
  };

  it("applies the annual rate to the reducing carrying value", () => {
    expect(computeNbv(p, "2025-01-01").nbv).toBe(7500); // 10000 - 2500
    expect(computeNbv(p, "2026-01-01").nbv).toBe(5625); // 7500 - 1875
  });

  it("prorates a partial year", () => {
    // Half a year: 10000 * 0.25 * 0.5 = 1250 depreciation.
    expect(computeNbv(p, "2024-07-01").nbv).toBeCloseTo(8750, 0);
  });

  it("floors at salvage and never goes below", () => {
    const floored: DepreciationPolicy = { ...p, salvage_value: 5000, annual_rate_pct: 50 };
    // Year 1: min(5000, 10000-5000) = 5000 → carrying = 5000 = salvage.
    expect(computeNbv(floored, "2025-01-01").nbv).toBe(5000);
    expect(computeNbv(floored, "2030-01-01").nbv).toBe(5000);
  });
});

describe("depreciationSchedule — straight line", () => {
  const p: DepreciationPolicy = {
    method: "straight_line",
    cost: 10000,
    salvage_value: 1000,
    start_date: "2024-01-01",
    useful_life_months: 36,
    annual_rate_pct: null,
  };

  it("has one row per month and lands exactly on salvage", () => {
    const rows = depreciationSchedule(p);
    expect(rows).toHaveLength(36);
    expect(rows[0]!.granularity).toBe("month");
    expect(rows[0]!.periodStart).toBe("2024-01-01");
    expect(rows[0]!.openingValue).toBe(10000);
    const last = rows[rows.length - 1]!;
    expect(last.closingValue).toBe(1000); // exact salvage, rounding absorbed
    expect(last.accumulatedDepreciation).toBe(9000);
  });
});

describe("depreciationSchedule — reducing balance", () => {
  const p: DepreciationPolicy = {
    method: "reducing_balance",
    cost: 10000,
    salvage_value: 0,
    start_date: "2024-01-01",
    useful_life_months: 60,
    annual_rate_pct: 25,
  };

  it("has annual rows across the horizon", () => {
    const rows = depreciationSchedule(p);
    expect(rows).toHaveLength(5); // 60 months → 5 years
    expect(rows[0]!.granularity).toBe("year");
    expect(rows[0]!.depreciation).toBe(2500);
    expect(rows[0]!.closingValue).toBe(7500);
    expect(rows[1]!.periodStart).toBe("2025-01-01");
    expect(rows[1]!.depreciation).toBe(1875);
  });

  it("stops early once salvage is reached", () => {
    const rows = depreciationSchedule({ ...p, salvage_value: 5000, annual_rate_pct: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closingValue).toBe(5000);
  });
});

describe("depreciationPolicySchema", () => {
  const base = { asset_id: "11111111-1111-1111-1111-111111111111", start_date: "2024-01-01", cost: "10000" };

  it("requires a useful life for straight line", () => {
    const bad = depreciationPolicySchema.safeParse({ ...base, method: "straight_line" });
    expect(bad.success).toBe(false);
    const ok = depreciationPolicySchema.safeParse({ ...base, method: "straight_line", useful_life_months: "36" });
    expect(ok.success).toBe(true);
  });

  it("requires a rate for reducing balance", () => {
    const bad = depreciationPolicySchema.safeParse({ ...base, method: "reducing_balance" });
    expect(bad.success).toBe(false);
    const ok = depreciationPolicySchema.safeParse({ ...base, method: "reducing_balance", annual_rate_pct: "25" });
    expect(ok.success).toBe(true);
  });

  it("rejects salvage above cost", () => {
    const bad = depreciationPolicySchema.safeParse({
      ...base,
      method: "straight_line",
      useful_life_months: "36",
      salvage_value: "20000",
    });
    expect(bad.success).toBe(false);
  });
});

describe("friendlyDepreciationError", () => {
  it("maps the method-params check", () => {
    expect(friendlyDepreciationError("23514", "asset_depreciation_method_params_check")).toMatch(/method needs/i);
  });
  it("maps the salvage check", () => {
    expect(friendlyDepreciationError("check_violation", "asset_depreciation_salvage_le_cost_check")).toMatch(/salvage/i);
  });
  it("has a generic fallback", () => {
    expect(friendlyDepreciationError(undefined, undefined)).toMatch(/couldn't save/i);
  });
});
