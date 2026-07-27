import { describe, it, expect } from "vitest";
import {
  aggregateWorkforce,
  computeEmployeeStats,
  emptyEmployeeStats,
  formatDuration,
  formatRate,
  memoryUsageLabel,
  startOfUtcDayIso,
  type MemoryStatRow,
  type TaskStatRow,
} from "@/lib/ai-employees/stats";

/**
 * CrewFlow HQ — AI Employee workforce telemetry pure-logic tests
 * (CEO Directive 004, Phase 3).
 *
 * The boardroom roster + detail pages render entirely from
 * `computeEmployeeStats` / `aggregateWorkforce`, so these tests pin the
 * directive's per-employee fields (tasks today, success rate, avg
 * completion time, last completed task, knowledge version, memory usage)
 * and the workforce roll-up, plus the shared formatting helpers.
 */

// Fixed "now" so the UTC day boundary is deterministic across machines.
const NOW = "2026-06-17T12:00:00.000Z";

function task(over: Partial<TaskStatRow> = {}): TaskStatRow {
  return {
    status: "completed",
    title: "Untitled task",
    created_at: "2026-06-17T09:00:00.000Z",
    completed_at: "2026-06-17T09:02:00.000Z",
    ...over,
  };
}

function mem(content: string): MemoryStatRow {
  return { content };
}

describe("stats — formatDuration", () => {
  it("renders compact, human-readable durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
  });
});

describe("stats — memoryUsageLabel", () => {
  it("labels the stored character footprint as a size", () => {
    expect(memoryUsageLabel(0)).toBe("0 B");
    expect(memoryUsageLabel(500)).toBe("500 B");
    expect(memoryUsageLabel(1000)).toBe("1.0 KB");
    expect(memoryUsageLabel(2500)).toBe("2.5 KB");
    expect(memoryUsageLabel(15_000)).toBe("15 KB");
    expect(memoryUsageLabel(2_000_000)).toBe("2.0 MB");
  });
});

describe("stats — formatRate", () => {
  it("shows '—' for unmeasured rates and 'N%' otherwise", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(75)).toBe("75%");
  });
});

describe("stats — startOfUtcDayIso", () => {
  it("floors to the UTC day boundary", () => {
    expect(startOfUtcDayIso(NOW)).toBe("2026-06-17T00:00:00.000Z");
  });
});

describe("stats — computeEmployeeStats", () => {
  const tasks: TaskStatRow[] = [
    // Two completed today (2m + 4m → avg 3m); newest completion is t1.
    task({
      title: "Draft proposal",
      created_at: "2026-06-17T09:00:00.000Z",
      completed_at: "2026-06-17T09:02:00.000Z",
    }),
    task({
      title: "Summarise deal",
      created_at: "2026-06-17T08:00:00.000Z",
      completed_at: "2026-06-17T08:04:00.000Z",
    }),
    // Failed yesterday — counts toward success rate, not "today".
    task({
      status: "failed",
      title: "Enrich account",
      created_at: "2026-06-16T10:00:00.000Z",
      completed_at: "2026-06-16T10:05:00.000Z",
    }),
    // In progress today — counts toward "today" + in-progress only.
    task({
      status: "in_progress",
      title: "Build sequence",
      created_at: "2026-06-17T11:00:00.000Z",
      completed_at: null,
    }),
    // Pending, two days ago — neither today nor terminal.
    task({
      status: "pending",
      title: "Plan campaign",
      created_at: "2026-06-15T10:00:00.000Z",
      completed_at: null,
    }),
  ];
  const memory = [mem("abc"), mem("x".repeat(1200))];
  const stats = computeEmployeeStats(tasks, memory, { nowIso: NOW });

  it("counts tasks created since the UTC day boundary", () => {
    expect(stats.tasksToday).toBe(3);
    expect(stats.tasksTotal).toBe(5);
    expect(stats.inProgress).toBe(1);
  });

  it("derives success rate from completed vs failed", () => {
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    // 2 / (2 + 1) = 66.7 → 67.
    expect(stats.successRatePct).toBe(67);
  });

  it("averages wall-clock completion time across completed tasks", () => {
    // (2m + 4m) / 2 = 3m.
    expect(stats.avgCompletionMs).toBe(180_000);
    expect(stats.avgCompletionLabel).toBe("3m");
  });

  it("reports the newest completed task", () => {
    expect(stats.lastCompletedTitle).toBe("Draft proposal");
    expect(stats.lastCompletedAt).toBe("2026-06-17T09:02:00.000Z");
  });

  it("derives knowledge version + memory usage from memory entries", () => {
    expect(stats.memoryEntries).toBe(2);
    expect(stats.memoryChars).toBe(1203);
    expect(stats.knowledgeVersion).toBe(3); // 1 + entries
    expect(stats.memoryUsageLabel).toBe("1.2 KB");
  });
});

describe("stats — empty baseline never produces NaN", () => {
  it("zeroes everything and leaves rates unmeasured", () => {
    const s = emptyEmployeeStats();
    expect(s.tasksToday).toBe(0);
    expect(s.successRatePct).toBeNull();
    expect(s.avgCompletionMs).toBeNull();
    expect(s.avgCompletionLabel).toBe("—");
    expect(s.lastCompletedTitle).toBeNull();
    expect(s.knowledgeVersion).toBe(1);
    expect(s.memoryUsageLabel).toBe("0 B");
  });
});

describe("stats — aggregateWorkforce", () => {
  const employees = [
    { status: "working" },
    { status: "working" },
    { status: "idle" },
    { status: "waiting_approval" },
    { status: "error" },
    { status: "blocked" },
  ];

  // Employee A: 3 completed (2m each) + 1 failed, all today; 2 memories.
  const aTasks: TaskStatRow[] = [
    task({ created_at: "2026-06-17T09:00:00.000Z", completed_at: "2026-06-17T09:02:00.000Z" }),
    task({ created_at: "2026-06-17T09:10:00.000Z", completed_at: "2026-06-17T09:12:00.000Z" }),
    task({ created_at: "2026-06-17T09:20:00.000Z", completed_at: "2026-06-17T09:22:00.000Z" }),
    task({ status: "failed", created_at: "2026-06-17T09:30:00.000Z", completed_at: "2026-06-17T09:31:00.000Z" }),
  ];
  // Employee B: 1 completed (2m) today; 1 memory.
  const bTasks: TaskStatRow[] = [
    task({ created_at: "2026-06-17T10:00:00.000Z", completed_at: "2026-06-17T10:02:00.000Z" }),
  ];
  const statsA = computeEmployeeStats(aTasks, [mem("aa"), mem("bb")], { nowIso: NOW });
  const statsB = computeEmployeeStats(bTasks, [mem("cc")], { nowIso: NOW });
  const summary = aggregateWorkforce(employees, [statsA, statsB]);

  it("counts live statuses from the roster", () => {
    expect(summary.totalEmployees).toBe(6);
    expect(summary.activeWorkers).toBe(2);
    expect(summary.waitingApproval).toBe(1);
    expect(summary.blockedOrError).toBe(2);
  });

  it("rolls up task + success totals across employees", () => {
    expect(summary.tasksToday).toBe(5);
    expect(summary.completedTotal).toBe(4);
    expect(summary.failedTotal).toBe(1);
    // 4 / (4 + 1) = 80%.
    expect(summary.successRatePct).toBe(80);
  });

  it("rolls up the weighted average completion time + memory", () => {
    // Every completed task ran ~2m, so the weighted mean is 2m.
    expect(summary.avgCompletionLabel).toBe("2m");
    expect(summary.totalMemoryEntries).toBe(3);
  });
});
