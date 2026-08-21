/**
 * CrewFlow HQ — the Workflow-Saga PURE MODEL.
 *
 * A saga is a directive decomposed into a cross-department task GRAPH: an ordered
 * list of steps, each optionally depending on ONE earlier step, each mapping to (or
 * creating) a single hq_ai_tasks row. This module owns the SHAPE of that graph and
 * the DETERMINISTIC rules over it — validation (unique ordinals, in-range and
 * acyclic dependencies), and the honest status rollup from steps to saga.
 *
 * PURE, server/client-safe, and DETERMINISTIC — no `server-only`, no Supabase, no
 * SDK, and NO wall-clock read (`Date.now()` / `new Date()`): any `now` a caller
 * needs is INJECTED, exactly like lib/hq/boardroom-cards.ts. The service layer, the
 * saga board page, the decomposition templates, and the unit tests all share this
 * one vocabulary.
 *
 * A first principle runs through the rollup: HONEST status — a step's status is the
 * real state of its task (or 'pending' when undispatched), never a green conjured
 * from absent work; and a saga's status is derived from its steps, never asserted
 * independently of them.
 */

// ---------------------------------------------------------------------
// Status vocabularies — the single source of truth, mirrored by the
// migration's CHECK constraints (hq_workflow_sagas.status / hq_saga_steps.status).
// ---------------------------------------------------------------------

export const SAGA_STATUSES = ["planned", "running", "blocked", "done", "abandoned"] as const;
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export const STEP_STATUSES = [
  "pending",
  "running",
  "blocked",
  "done",
  "skipped",
  "failed",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** A step that has reached a terminal state — no further work will move it. */
const TERMINAL_STEP_STATUSES = new Set<StepStatus>(["done", "skipped", "failed"]);
export function isTerminalStep(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

// ---------------------------------------------------------------------
// The graph shape.
// ---------------------------------------------------------------------

/**
 * One step in a saga's graph. `ordinal` is its 1-based position; `dependsOnOrdinal`
 * is the ordinal of the ONE earlier step it waits on (null ⇒ a root step). This is
 * the shape both the deterministic templates PRODUCE and the persisted
 * `hq_saga_steps` rows PROJECT to.
 */
export interface SagaStep {
  ordinal: number;
  title: string;
  department: string | null;
  role: string | null;
  dependsOnOrdinal: number | null;
  status: StepStatus;
}

/** A saga plus its ordered steps — the model the pure functions reason over. */
export interface Saga {
  title: string;
  status: SagaStatus;
  templateKey: string | null;
  steps: SagaStep[];
}

// ---------------------------------------------------------------------
// Validation — the deterministic invariants of a well-formed graph.
// ---------------------------------------------------------------------

export type GraphValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a step graph. TOTAL and PURE: it returns every violation it finds
 * rather than throwing on the first, so a caller (or a test) sees the whole
 * picture. The invariants, each a way a graph can be malformed:
 *
 *   1. ordinals are unique and 1-based contiguous (1..n) — the persisted unique
 *      constraint pins uniqueness; contiguity is the template contract;
 *   2. a dependency references an EARLIER, existing ordinal — an edge to a
 *      later or missing step is not a real dependency;
 *   3. no step depends on itself (the DB CHECK pins this too);
 *   4. the graph is ACYCLIC — a saga that can never start is not a saga. Because
 *      every edge points to a strictly-earlier ordinal (invariant 2), acyclicity
 *      is implied; this function proves it directly so the guarantee does not
 *      rest on a second reading of invariant 2.
 */
export function validateStepGraph(steps: ReadonlyArray<SagaStep>): GraphValidation {
  const errors: string[] = [];

  if (steps.length === 0) {
    return { ok: false, errors: ["a saga must have at least one step"] };
  }

  // 1. Unique, contiguous, 1-based ordinals.
  const seen = new Set<number>();
  for (const s of steps) {
    if (!Number.isInteger(s.ordinal) || s.ordinal < 1) {
      errors.push(`step "${s.title}" has a non-positive/non-integer ordinal ${s.ordinal}`);
      continue;
    }
    if (seen.has(s.ordinal)) errors.push(`duplicate ordinal ${s.ordinal}`);
    seen.add(s.ordinal);
  }
  const sorted = [...seen].sort((a, b) => a - b);
  sorted.forEach((ord, i) => {
    if (ord !== i + 1) errors.push(`ordinals are not contiguous from 1 (found ${ord} at position ${i + 1})`);
  });

  // 2 + 3. Dependencies reference an earlier, existing ordinal, never self.
  for (const s of steps) {
    const dep = s.dependsOnOrdinal;
    if (dep === null) continue;
    if (dep === s.ordinal) {
      errors.push(`step ${s.ordinal} depends on itself`);
      continue;
    }
    if (!seen.has(dep)) {
      errors.push(`step ${s.ordinal} depends on ordinal ${dep}, which does not exist`);
      continue;
    }
    if (dep > s.ordinal) {
      errors.push(`step ${s.ordinal} depends on a LATER step ${dep} (edges must point earlier)`);
    }
  }

  // 4. Acyclicity, proven directly (Kahn's algorithm over the single-predecessor
  //    edges). A cycle leaves at least one node unremovable.
  if (hasCycle(steps)) {
    errors.push("the step graph contains a cycle");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Does the graph contain a cycle? PURE. Each step has at most one predecessor
 * (`dependsOnOrdinal`), so the graph is a forest of chains unless an edge closes a
 * loop; a topological sort (Kahn) that cannot remove every node has found one.
 */
export function hasCycle(steps: ReadonlyArray<SagaStep>): boolean {
  const byOrdinal = new Map<number, SagaStep>();
  for (const s of steps) byOrdinal.set(s.ordinal, s);

  // indegree = number of steps that depend ON me.
  const indegree = new Map<number, number>();
  for (const s of steps) indegree.set(s.ordinal, 0);
  for (const s of steps) {
    const dep = s.dependsOnOrdinal;
    if (dep !== null && byOrdinal.has(dep)) {
      indegree.set(dep, (indegree.get(dep) ?? 0) + 1);
    }
  }

  // Repeatedly remove a node with indegree 0 (nothing depends on it).
  const queue: number[] = [];
  for (const [ord, deg] of indegree) if (deg === 0) queue.push(ord);
  let removed = 0;
  while (queue.length > 0) {
    const ord = queue.pop()!;
    removed += 1;
    const dep = byOrdinal.get(ord)?.dependsOnOrdinal ?? null;
    if (dep !== null && indegree.has(dep)) {
      const next = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }
  return removed !== steps.length;
}

// ---------------------------------------------------------------------
// Dependency readiness — which steps CAN start right now.
// ---------------------------------------------------------------------

/**
 * Is this step's dependency satisfied — i.e. may it be advanced? A root step (no
 * dependency) is always ready; a dependent step is ready only once its predecessor
 * is `done`. PURE. Returns false for an unknown/unsatisfiable dependency rather
 * than throwing, so an ill-formed graph degrades to "not ready" (fail-safe).
 */
export function isStepReady(step: SagaStep, steps: ReadonlyArray<SagaStep>): boolean {
  if (step.dependsOnOrdinal === null) return true;
  const dep = steps.find((s) => s.ordinal === step.dependsOnOrdinal);
  return dep !== undefined && dep.status === "done";
}

// ---------------------------------------------------------------------
// Approval gating — which ready steps a HUMAN must still release.
// ---------------------------------------------------------------------

/**
 * Departments whose work maps to an APPROVAL-GATED action — one that reaches OUTSIDE
 * the internal build (publishes public content, contacts a customer, deploys to prod,
 * moves money). The autonomous saga-drain must NEVER dispatch a step in one of these
 * departments on its own; a super-admin's MANUAL advance is the human approval that
 * releases it. The internal-build departments (Research, Product, Design, Engineering,
 * QA) carry no such gate — their work is safe to dispatch deterministically.
 *
 * Matched case-insensitively against the step's `department`, so roster casing drift
 * ("operations" vs "Operations") cannot silently open a gate. A step with NO
 * department is treated as GATED (fail-safe: an unclassified action waits for a human).
 */
export const APPROVAL_GATED_DEPARTMENTS: ReadonlyArray<string> = [
  "marketing",
  "sales",
  "operations",
  "support",
  "customer success",
  "finance",
];

const APPROVAL_GATED_SET = new Set<string>(APPROVAL_GATED_DEPARTMENTS);

/**
 * Does advancing this step require a human's approval — i.e. must the autonomous
 * drain HALT and leave it for the manual advance? PURE and DETERMINISTIC. True when
 * the step's department maps to an externally-visible / irreversible action, or when
 * the step has NO department to classify (fail-safe: an unclassified action is never
 * auto-dispatched). False only for a known internal-build department.
 */
export function stepRequiresApproval(step: Pick<SagaStep, "department">): boolean {
  const dept = step.department?.trim().toLowerCase();
  if (!dept) return true;
  return APPROVAL_GATED_SET.has(dept);
}

// ---------------------------------------------------------------------
// The status rollup — a saga's status DERIVED from its steps, honestly.
// ---------------------------------------------------------------------

/**
 * Derive a saga's status from its steps. PURE and DETERMINISTIC. The rollup, in
 * priority order (worst-and-most-informative first):
 *
 *   • no steps            → 'planned'   (nothing to run yet)
 *   • every step terminal:
 *       - any failed      → 'blocked'   (a failed step blocks completion honestly)
 *       - else            → 'done'      (all done/skipped — the work is finished)
 *   • any step blocked or failed, none running → 'blocked'
 *   • any step running                          → 'running'
 *   • otherwise (all pending)                   → 'planned'
 *
 * 'abandoned' is a HUMAN act, never derived — a super-admin abandons a saga; no
 * arrangement of step states produces it. So the rollup never returns it, and the
 * service treats an abandoned saga as terminal and does not recompute it.
 */
export function deriveSagaStatus(steps: ReadonlyArray<SagaStep>): SagaStatus {
  if (steps.length === 0) return "planned";

  const allTerminal = steps.every((s) => isTerminalStep(s.status));
  if (allTerminal) {
    return steps.some((s) => s.status === "failed") ? "blocked" : "done";
  }

  const anyRunning = steps.some((s) => s.status === "running");
  const anyBlockedOrFailed = steps.some((s) => s.status === "blocked" || s.status === "failed");

  if (anyBlockedOrFailed && !anyRunning) return "blocked";
  if (anyRunning) return "running";
  return "planned";
}

/**
 * A compact, deterministic progress summary for a saga's steps — the honest
 * numbers a read-only board renders. PURE.
 */
export interface SagaProgress {
  total: number;
  done: number;
  running: number;
  blocked: number;
  failed: number;
  pending: number;
  skipped: number;
  /** 0 to 100 integer share of steps that are `done`. */
  donePct: number;
}

export function sagaProgress(steps: ReadonlyArray<SagaStep>): SagaProgress {
  const count = (st: StepStatus) => steps.filter((s) => s.status === st).length;
  const total = steps.length;
  const done = count("done");
  return {
    total,
    done,
    running: count("running"),
    blocked: count("blocked"),
    failed: count("failed"),
    pending: count("pending"),
    skipped: count("skipped"),
    donePct: total === 0 ? 0 : Math.round((100 * done) / total),
  };
}
