import { describe, it, expect } from "vitest";
import {
  computeCriticalPath,
  milestoneDurationDays,
  type CpmMilestoneInput,
  type CpmEdgeInput,
} from "@/lib/jobs/critical-path";

/**
 * CPM pure-function proofs (capability 3: milestone dependencies + critical path).
 */

const point = (id: string, sort: number, end: string): CpmMilestoneInput => ({
  id,
  planned_start: null,
  planned_end: end,
  sort,
});
const bar = (
  id: string,
  sort: number,
  start: string,
  end: string,
): CpmMilestoneInput => ({ id, planned_start: start, planned_end: end, sort });
const dep = (successor: string, predecessor: string): CpmEdgeInput => ({
  milestone_id: successor,
  depends_on_milestone_id: predecessor,
});

describe("milestoneDurationDays", () => {
  it("a point milestone (no start) is one day", () => {
    expect(milestoneDurationDays(point("a", 1, "2026-08-10"))).toBe(1);
  });
  it("a bar is inclusive whole days (same day = 1)", () => {
    expect(milestoneDurationDays(bar("a", 1, "2026-08-10", "2026-08-10"))).toBe(1);
    expect(milestoneDurationDays(bar("a", 1, "2026-08-10", "2026-08-14"))).toBe(5);
  });
  it("a malformed / reversed window falls back to one day (never negative)", () => {
    expect(milestoneDurationDays(bar("a", 1, "2026-08-14", "2026-08-10"))).toBe(1);
    expect(milestoneDurationDays(bar("a", 1, "nope", "2026-08-10"))).toBe(1);
  });
});

describe("computeCriticalPath — linear chain", () => {
  const ms = [
    point("a", 1, "2026-08-01"),
    point("b", 2, "2026-08-02"),
    point("c", 3, "2026-08-03"),
  ];
  const edges = [dep("b", "a"), dep("c", "b")]; // a → b → c

  it("every milestone on a single chain is critical", () => {
    const r = computeCriticalPath(ms, edges);
    expect(r.cyclic).toBe(false);
    expect(r.projectDurationDays).toBe(3);
    expect(r.criticalPath).toEqual(["a", "b", "c"]);
    expect(r.nodes.every((n) => n.isCritical)).toBe(true);
    expect(r.nodes.every((n) => n.totalFloat === 0)).toBe(true);
  });

  it("earliest starts stack up the chain", () => {
    const r = computeCriticalPath(ms, edges);
    const es = Object.fromEntries(r.nodes.map((n) => [n.id, n.earliestStart]));
    expect(es).toEqual({ a: 0, b: 1, c: 2 });
  });
});

describe("computeCriticalPath — diamond with a slack path", () => {
  // a → {b (5d), c (1d)} → d. The long arm (a,b,d) is critical; c has float.
  const ms = [
    bar("a", 1, "2026-08-01", "2026-08-01"), // 1d
    bar("b", 2, "2026-08-02", "2026-08-06"), // 5d
    bar("c", 3, "2026-08-02", "2026-08-02"), // 1d
    bar("d", 4, "2026-08-07", "2026-08-07"), // 1d
  ];
  const edges = [dep("b", "a"), dep("c", "a"), dep("d", "b"), dep("d", "c")];

  it("the long arm is critical, the short arm floats", () => {
    const r = computeCriticalPath(ms, edges);
    expect(r.cyclic).toBe(false);
    expect(r.projectDurationDays).toBe(1 + 5 + 1); // a + b + d
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId.a!.isCritical).toBe(true);
    expect(byId.b!.isCritical).toBe(true);
    expect(byId.d!.isCritical).toBe(true);
    expect(byId.c!.isCritical).toBe(false);
    expect(byId.c!.totalFloat).toBe(4); // 5d arm − 1d arm
    expect(r.criticalPath).toEqual(["a", "b", "d"]);
  });
});

describe("computeCriticalPath — determinism & robustness", () => {
  const ms = [
    point("a", 1, "2026-08-01"),
    point("b", 2, "2026-08-02"),
    point("c", 3, "2026-08-03"),
  ];
  const edges = [dep("b", "a"), dep("c", "b")];

  it("is independent of input array order", () => {
    const forward = computeCriticalPath(ms, edges);
    const shuffled = computeCriticalPath([...ms].reverse(), [...edges].reverse());
    expect(shuffled).toEqual(forward);
  });

  it("no dependencies → every milestone can start at day 0, all critical", () => {
    const r = computeCriticalPath(ms, []);
    expect(r.cyclic).toBe(false);
    expect(r.nodes.every((n) => n.earliestStart === 0)).toBe(true);
    // With no edges there is no float anywhere (each is its own longest path).
    expect(r.projectDurationDays).toBe(1);
  });

  it("ignores edges whose endpoints are not both present", () => {
    const r = computeCriticalPath(ms, [dep("b", "a"), dep("c", "ghost")]);
    expect(r.cyclic).toBe(false);
    // The ghost edge is dropped, so c has no predecessor and starts at 0.
    const c = r.nodes.find((n) => n.id === "c")!;
    expect(c.earliestStart).toBe(0);
  });

  it("empty milestone set is a clean zero-length result", () => {
    const r = computeCriticalPath([], []);
    expect(r).toEqual({
      cyclic: false,
      projectDurationDays: 0,
      nodes: [],
      criticalPath: [],
    });
  });
});

describe("computeCriticalPath — cycle detection", () => {
  it("reports cyclic and draws no path when the graph loops", () => {
    const ms = [point("a", 1, "2026-08-01"), point("b", 2, "2026-08-02")];
    const r = computeCriticalPath(ms, [dep("b", "a"), dep("a", "b")]);
    expect(r.cyclic).toBe(true);
    expect(r.criticalPath).toEqual([]);
    expect(r.projectDurationDays).toBe(0);
    // It still returns a node per milestone (so the UI can list them).
    expect(r.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("detects an indirect cycle", () => {
    const ms = [
      point("a", 1, "2026-08-01"),
      point("b", 2, "2026-08-02"),
      point("c", 3, "2026-08-03"),
    ];
    const r = computeCriticalPath(ms, [dep("b", "a"), dep("c", "b"), dep("a", "c")]);
    expect(r.cyclic).toBe(true);
  });
});
