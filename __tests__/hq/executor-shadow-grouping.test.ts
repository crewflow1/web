import { describe, it, expect } from "vitest";
import {
  UNKNOWN_GROUP_LABEL,
  groupShadowObservations,
  summarizeShadowOutcomes,
  zeroOutcomes,
  type ShadowObservationView,
  type ShadowTaskMeta,
} from "@/lib/executor-shadow/grouping";

/**
 * Executor-shadow observability — grouping contracts (Train 11).
 *
 * The /admin/executor-shadow page is the evidence base for the CEO's
 * live-execution decision, so the fold that produces its summary must be honest:
 * every observation counted exactly once, unknown task meta grouped visibly
 * (never dropped), deterministic ordering.
 */

let nextId = 1;
function obs(over: Partial<ShadowObservationView> = {}): ShadowObservationView {
  return {
    id: nextId++,
    outcome: "planned",
    taskId: "task-1",
    actionId: "lead:lead_1:memory.write",
    toolLabel: "memory.write",
    idempotencyKey: "key-1",
    reason: null,
    detail: "",
    correlationId: "corr-1",
    observedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

const META: ReadonlyMap<string, ShadowTaskMeta> = new Map([
  ["task-1", { taskType: "research.brief", employeeName: "Research AI" }],
  ["task-2", { taskType: "sales.followup", employeeName: "Sales AI" }],
  ["task-3", { taskType: "research.brief", employeeName: null }],
]);

describe("groupShadowObservations", () => {
  it("groups by (employee, task type) and counts each outcome", () => {
    const rows = [
      obs({ taskId: "task-1", outcome: "planned" }),
      obs({ taskId: "task-1", outcome: "refused" }),
      obs({ taskId: "task-1", outcome: "planned" }),
      obs({ taskId: "task-2", outcome: "error" }),
    ];
    const groups = groupShadowObservations(rows, META);
    expect(groups).toHaveLength(2);
    // Busiest first.
    expect(groups[0]).toMatchObject({
      employeeName: "Research AI",
      taskType: "research.brief",
      total: 3,
      outcomes: { planned: 2, refused: 1, error: 0 },
    });
    expect(groups[1]).toMatchObject({
      employeeName: "Sales AI",
      total: 1,
      outcomes: { planned: 0, refused: 0, error: 1 },
    });
  });

  it("every observation lands in exactly one group — totals reconcile", () => {
    const rows = [
      obs({ taskId: "task-1" }),
      obs({ taskId: "task-2" }),
      obs({ taskId: "task-3" }),
      obs({ taskId: "task-missing" }),
    ];
    const groups = groupShadowObservations(rows, META);
    expect(groups.reduce((n, g) => n + g.total, 0)).toBe(rows.length);
  });

  it("unknown task meta is grouped VISIBLY under the unknown label, never dropped", () => {
    const rows = [obs({ taskId: "task-missing" }), obs({ taskId: "task-3" })];
    const groups = groupShadowObservations(rows, META);
    // task-missing → unknown employee + unknown type; task-3 → unknown employee, known type.
    const labels = groups.map((g) => `${g.employeeName}/${g.taskType}`).sort();
    expect(labels).toEqual([
      `${UNKNOWN_GROUP_LABEL}/research.brief`,
      `${UNKNOWN_GROUP_LABEL}/${UNKNOWN_GROUP_LABEL}`,
    ]);
  });

  it("tracks the group's NEWEST observation regardless of input order", () => {
    const rows = [
      obs({ taskId: "task-1", observedAt: "2026-08-01T09:00:00.000Z" }),
      obs({ taskId: "task-1", observedAt: "2026-08-01T11:30:00.000Z" }),
      obs({ taskId: "task-1", observedAt: "2026-08-01T10:00:00.000Z" }),
    ];
    const groups = groupShadowObservations(rows, META);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lastObservedAt).toBe("2026-08-01T11:30:00.000Z");
  });

  it("orders deterministically: busiest first, then alphabetical", () => {
    const rows = [
      obs({ taskId: "task-1" }),
      obs({ taskId: "task-2" }),
      obs({ taskId: "task-missing" }),
    ];
    const a = groupShadowObservations(rows, META).map((g) => g.key);
    const b = groupShadowObservations([...rows].reverse(), META).map((g) => g.key);
    expect(a).toEqual(b);
  });

  it("returns an empty list for no observations", () => {
    expect(groupShadowObservations([], META)).toEqual([]);
  });
});

describe("summarizeShadowOutcomes", () => {
  it("totals every outcome across the window", () => {
    const rows = [
      obs({ outcome: "planned" }),
      obs({ outcome: "planned" }),
      obs({ outcome: "refused" }),
      obs({ outcome: "error" }),
    ];
    expect(summarizeShadowOutcomes(rows)).toEqual({ planned: 2, refused: 1, error: 1 });
  });

  it("is zero-filled for an empty window", () => {
    expect(summarizeShadowOutcomes([])).toEqual(zeroOutcomes());
  });
});
