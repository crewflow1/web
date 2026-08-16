import { describe, it, expect } from "vitest";
import {
  median,
  summarisePayrollRun,
  detectPayrollAnomalies,
  buildPayrollInsights,
  MIN_HISTORY_RUNS,
  type CurrentLine,
  type HistoricalRun,
  type PayrollInsight,
} from "@/lib/payroll/insights";

// Three steady prior runs: u1 does 40h/£600, u4 does 20h/£300, every run.
const STEADY_HISTORY: HistoricalRun[] = [
  {
    run_id: "r1",
    period_start: "2025-01-01",
    lines: [
      { user_id: "u1", hours: 40, gross_pay: 600 },
      { user_id: "u4", hours: 20, gross_pay: 300 },
    ],
  },
  {
    run_id: "r2",
    period_start: "2025-02-01",
    lines: [
      { user_id: "u1", hours: 40, gross_pay: 600 },
      { user_id: "u4", hours: 20, gross_pay: 300 },
    ],
  },
  {
    run_id: "r3",
    period_start: "2025-03-01",
    lines: [
      { user_id: "u1", hours: 40, gross_pay: 600 },
      { user_id: "u4", hours: 20, gross_pay: 300 },
    ],
  },
];

const byCode = (arr: PayrollInsight[], code: string, userId?: string) =>
  arr.find((i) => i.code === code && (userId === undefined || i.user_id === userId));

describe("median", () => {
  it("odd and even lengths", () => {
    expect(median([40, 40, 40])).toBe(40);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBe(0);
  });
  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("summarisePayrollRun", () => {
  it("narrates headcount, hours, gross and the largest line", () => {
    const s = summarisePayrollRun({
      cycle: "monthly",
      period_start: "2025-04-01",
      period_end: "2025-04-30",
      lines: [
        { user_id: "u1", subject: "Alice", hours: 40, gross_pay: 600 },
        { user_id: "u2", subject: "Bob", hours: 80, gross_pay: 1200 },
      ],
    });
    expect(s.code).toBe("run_summary");
    expect(s.detail).toContain("2 people");
    expect(s.detail).toContain("Bob"); // the largest line
    expect(s.detail).toContain("£1,200.00");
  });

  it("handles an empty run", () => {
    const s = summarisePayrollRun({
      cycle: "weekly",
      period_start: "2025-04-01",
      period_end: "2025-04-07",
      lines: [],
    });
    expect(s.detail).toContain("No staff");
  });
});

describe("detectPayrollAnomalies", () => {
  it("flags an hours outlier vs the person's usual (median)", () => {
    const current: CurrentLine[] = [{ user_id: "u1", subject: "Alice", hours: 10, gross_pay: 150 }];
    const found = detectPayrollAnomalies(current, STEADY_HISTORY);
    const outlier = byCode(found, "hours_outlier", "u1");
    expect(outlier).toBeDefined();
    expect(outlier!.severity).toBe("warning");
    // Shows its working: usual 40h, this run 10h.
    expect(outlier!.reasoning).toContain("40.00h");
    expect(outlier!.reasoning).toContain("10.00h");
  });

  it("flags a gross-pay jump vs the last run", () => {
    const current: CurrentLine[] = [{ user_id: "u1", subject: "Alice", hours: 10, gross_pay: 150 }];
    const jump = byCode(detectPayrollAnomalies(current, STEADY_HISTORY), "gross_jump", "u1");
    expect(jump).toBeDefined();
    expect(jump!.reasoning).toContain("£600.00");
    expect(jump!.reasoning).toContain("£150.00");
  });

  it("does NOT flag a steady line", () => {
    const current: CurrentLine[] = [{ user_id: "u1", subject: "Alice", hours: 40, gross_pay: 600 }];
    const found = detectPayrollAnomalies(current, STEADY_HISTORY);
    expect(byCode(found, "hours_outlier", "u1")).toBeUndefined();
    expect(byCode(found, "gross_jump", "u1")).toBeUndefined();
  });

  it("respects the thresholds — a small change under the floor is not flagged", () => {
    // 40h → 36h is a 10% / 4h drop: under both HOURS_OUTLIER_PCT and _MIN_ABS.
    const current: CurrentLine[] = [{ user_id: "u1", subject: "Alice", hours: 36, gross_pay: 540 }];
    const found = detectPayrollAnomalies(current, STEADY_HISTORY);
    expect(byCode(found, "hours_outlier", "u1")).toBeUndefined();
    // £600 → £540 is 10% / £60: under both GROSS_JUMP_PCT and _MIN_ABS.
    expect(byCode(found, "gross_jump", "u1")).toBeUndefined();
  });

  it("flags a first-ever appearance as a new starter (info, not warning)", () => {
    const current: CurrentLine[] = [{ user_id: "u9", subject: "New Person", hours: 40, gross_pay: 600 }];
    const ns = byCode(detectPayrollAnomalies(current, STEADY_HISTORY), "new_starter", "u9");
    expect(ns).toBeDefined();
    expect(ns!.severity).toBe("info");
  });

  it("flags a zero-hours line even with no history", () => {
    const current: CurrentLine[] = [{ user_id: "u5", subject: "Empty", hours: 0, gross_pay: 0 }];
    const zh = byCode(detectPayrollAnomalies(current, []), "zero_hours", "u5");
    expect(zh).toBeDefined();
    expect(zh!.severity).toBe("warning");
  });

  it("flags a regular who is absent from the run (missing timesheet)", () => {
    // u4 appeared with hours in all 3 prior runs; u1 present, u4 absent.
    const current: CurrentLine[] = [{ user_id: "u1", subject: "Alice", hours: 40, gross_pay: 600 }];
    const miss = byCode(detectPayrollAnomalies(current, STEADY_HISTORY), "missing_timesheet", "u4");
    expect(miss).toBeDefined();
    expect(miss!.severity).toBe("warning");
    expect(miss!.reasoning).toContain("3 of the last 3");
  });

  it("is deterministic — identical input yields identical output", () => {
    const current: CurrentLine[] = [
      { user_id: "u1", subject: "Alice", hours: 10, gross_pay: 150 },
      { user_id: "u3", subject: "Zero", hours: 0, gross_pay: 0 },
    ];
    const a = detectPayrollAnomalies(current, STEADY_HISTORY);
    const b = detectPayrollAnomalies(current, STEADY_HISTORY);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Warnings sort before info.
    const firstInfo = a.findIndex((i) => i.severity === "info");
    const lastWarn = a.map((i) => i.severity).lastIndexOf("warning");
    if (firstInfo !== -1) expect(lastWarn).toBeLessThan(firstInfo);
  });
});

describe("buildPayrollInsights — insufficient-data path", () => {
  it("signals insufficient history with zero prior runs, but still runs safe checks", () => {
    const res = buildPayrollInsights({
      cycle: "monthly",
      period_start: "2025-04-01",
      period_end: "2025-04-30",
      current: [{ user_id: "u5", subject: "Empty", hours: 0, gross_pay: 0 }],
      history: [],
    });
    expect(res.hasSufficientHistory).toBe(false);
    expect(byCode(res.insights, "insufficient_history")).toBeDefined();
    // history-free checks still fire
    expect(byCode(res.insights, "zero_hours", "u5")).toBeDefined();
    expect(res.summary.code).toBe("run_summary");
  });

  it("one prior run is still insufficient (needs MIN_HISTORY_RUNS)", () => {
    expect(MIN_HISTORY_RUNS).toBeGreaterThanOrEqual(2);
    const res = buildPayrollInsights({
      cycle: "monthly",
      period_start: "2025-04-01",
      period_end: "2025-04-30",
      current: [{ user_id: "u1", subject: "Alice", hours: 10, gross_pay: 150 }],
      history: [STEADY_HISTORY[0]!],
    });
    expect(res.hasSufficientHistory).toBe(false);
    // With only 1 prior run there is no median-based outlier flag.
    expect(byCode(res.insights, "hours_outlier", "u1")).toBeUndefined();
  });

  it("marks sufficient history at MIN_HISTORY_RUNS runs", () => {
    const res = buildPayrollInsights({
      cycle: "monthly",
      period_start: "2025-04-01",
      period_end: "2025-04-30",
      current: [{ user_id: "u1", subject: "Alice", hours: 40, gross_pay: 600 }],
      history: STEADY_HISTORY,
    });
    expect(res.hasSufficientHistory).toBe(true);
    expect(byCode(res.insights, "insufficient_history")).toBeUndefined();
  });
});
