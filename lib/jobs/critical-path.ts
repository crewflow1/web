/**
 * Critical-path method (CPM) over a job's programme milestones — PURE, no I/O.
 *
 * Given the frozen milestone set of one baseline (20261085) plus the dependency
 * edges (20261132000002), this derives, for every milestone: its duration, the
 * earliest and latest it can start/finish, its total float (slack), and whether
 * it is CRITICAL — i.e. a day's slip on it slips the whole job.
 *
 * DIRECTION. An edge is "successor DEPENDS ON predecessor": the predecessor
 * must finish before the successor starts. So the forward pass follows
 * predecessor → successor.
 *
 * DURATION. A milestone with a planned_start is a bar of
 * (planned_end − planned_start + 1) whole days (inclusive, so a one-day bar has
 * duration 1). A milestone with only a planned_end is a point of duration 1.
 * Durations, not calendar dates, drive CPM — the dates come from the baseline
 * and are self-consistent within it.
 *
 * DETERMINISM. Every collection is processed in a stable order (milestone `sort`
 * then `id`), so the output is identical for identical input regardless of the
 * input array order. A cyclic edge set has no schedule; the RPC refuses to
 * persist one, and this function reports `cyclic: true` defensively rather than
 * looping.
 */

export interface CpmMilestoneInput {
  id: string;
  planned_start: string | null;
  planned_end: string;
  sort: number;
}

export interface CpmEdgeInput {
  /** The successor — the milestone that has the dependency. */
  milestone_id: string;
  /** The predecessor — must finish first. */
  depends_on_milestone_id: string;
}

export interface CpmNode {
  id: string;
  durationDays: number;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  totalFloat: number;
  isCritical: boolean;
}

export interface CpmResult {
  cyclic: boolean;
  /** Total programme length in days (0 when there are no milestones). */
  projectDurationDays: number;
  /** Per-milestone CPM figures, ordered by (sort, id). */
  nodes: CpmNode[];
  /** Critical milestone ids, in schedule order (earliestStart, then sort). */
  criticalPath: string[];
}

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); NaN on a malformed key. */
function daysBetween(from: string, to: string): number {
  if (!DAY_KEY.test(from) || !DAY_KEY.test(to)) return Number.NaN;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / DAY_MS);
}

/** Inclusive whole-day duration for a milestone; always at least 1. */
export function milestoneDurationDays(m: CpmMilestoneInput): number {
  if (!m.planned_start) return 1;
  const span = daysBetween(m.planned_start, m.planned_end);
  if (!Number.isFinite(span) || span < 0) return 1;
  return span + 1;
}

function stableSort(a: CpmMilestoneInput, b: CpmMilestoneInput): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compute the CPM figures for a milestone set + its dependency edges.
 *
 * Edges whose endpoints are not both in the milestone set are ignored (a
 * defensive belt against a stale edge referencing a superseded milestone).
 */
export function computeCriticalPath(
  milestones: CpmMilestoneInput[],
  edges: CpmEdgeInput[],
): CpmResult {
  const ordered = [...milestones].sort(stableSort);
  const ids = new Set(ordered.map((m) => m.id));
  const duration = new Map<string, number>();
  for (const m of ordered) duration.set(m.id, milestoneDurationDays(m));

  // Adjacency: predecessors[x] = nodes that must finish before x;
  //            successors[x]   = nodes that depend on x.
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const id of ids) {
    predecessors.set(id, []);
    successors.set(id, []);
  }
  // De-dupe + stable edge order for deterministic tie-breaks.
  const seen = new Set<string>();
  const cleanEdges = [...edges]
    .filter(
      (e) =>
        ids.has(e.milestone_id) &&
        ids.has(e.depends_on_milestone_id) &&
        e.milestone_id !== e.depends_on_milestone_id,
    )
    .filter((e) => {
      const k = `${e.depends_on_milestone_id}→${e.milestone_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => {
      const ka = `${a.depends_on_milestone_id}${a.milestone_id}`;
      const kb = `${b.depends_on_milestone_id}${b.milestone_id}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  for (const e of cleanEdges) {
    predecessors.get(e.milestone_id)!.push(e.depends_on_milestone_id);
    successors.get(e.depends_on_milestone_id)!.push(e.milestone_id);
  }

  // Kahn topological order (also the cycle detector).
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, predecessors.get(id)!.length);
  // Seed queue in stable order.
  const queue: string[] = ordered
    .filter((m) => indeg.get(m.id) === 0)
    .map((m) => m.id);
  const topo: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    topo.push(n);
    // Successors in stable (sort, id) order via `ordered`.
    for (const m of ordered) {
      if (!successors.get(n)!.includes(m.id)) continue;
      indeg.set(m.id, indeg.get(m.id)! - 1);
      if (indeg.get(m.id) === 0) queue.push(m.id);
    }
  }

  if (topo.length !== ids.size) {
    // A cycle: no schedule exists.
    return {
      cyclic: true,
      projectDurationDays: 0,
      nodes: ordered.map((m) => ({
        id: m.id,
        durationDays: duration.get(m.id)!,
        earliestStart: 0,
        earliestFinish: 0,
        latestStart: 0,
        latestFinish: 0,
        totalFloat: 0,
        isCritical: false,
      })),
      criticalPath: [],
    };
  }

  // Forward pass — earliest start/finish.
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of topo) {
    const preds = predecessors.get(id)!;
    const start = preds.length === 0 ? 0 : Math.max(...preds.map((p) => ef.get(p)!));
    es.set(id, start);
    ef.set(id, start + duration.get(id)!);
  }
  const projectDurationDays = ids.size === 0 ? 0 : Math.max(...[...ef.values()]);

  // Backward pass — latest start/finish.
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i]!;
    const succs = successors.get(id)!;
    const finish =
      succs.length === 0 ? projectDurationDays : Math.min(...succs.map((s) => ls.get(s)!));
    lf.set(id, finish);
    ls.set(id, finish - duration.get(id)!);
  }

  const nodes: CpmNode[] = ordered.map((m) => {
    const float = ls.get(m.id)! - es.get(m.id)!;
    return {
      id: m.id,
      durationDays: duration.get(m.id)!,
      earliestStart: es.get(m.id)!,
      earliestFinish: ef.get(m.id)!,
      latestStart: ls.get(m.id)!,
      latestFinish: lf.get(m.id)!,
      totalFloat: float,
      isCritical: float === 0,
    };
  });

  const criticalPath = nodes
    .filter((n) => n.isCritical)
    .sort((a, b) => {
      if (a.earliestStart !== b.earliestStart) return a.earliestStart - b.earliestStart;
      // tie-break by the stable milestone order
      const ia = ordered.findIndex((m) => m.id === a.id);
      const ib = ordered.findIndex((m) => m.id === b.id);
      return ia - ib;
    })
    .map((n) => n.id);

  return { cyclic: false, projectDurationDays, nodes, criticalPath };
}
