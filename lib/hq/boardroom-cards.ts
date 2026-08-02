/**
 * CrewFlow HQ — AI Boardroom card derivations (the Confidence / ETA / Health gap).
 *
 * The AI Boardroom showed only status COUNTS. The mandate calls for three
 * decision-grade cards per AI employee — Confidence, ETA, and Health — derived
 * DETERMINISTICALLY from the seams already on `hq_ai_tasks`:
 *
 *   • Confidence ← `verification` / `result` and the terminal execution outcome
 *   • ETA        ← the nearest `deadline_at` among a worker's ACTIVE tasks
 *   • Health     ← lease / heartbeat staleness + retry_count + the failed ratio
 *
 * Pure, server/client-safe derivations — NO Supabase / server-only imports, exactly
 * like `lib/ai-employees/stats.ts` and `lib/hq/executive.ts`. The service layer, the
 * boardroom pages, and the unit tests all share this one vocabulary. `now` is INJECTED
 * so every derivation is deterministic and testable.
 *
 * A first principle runs through all three: HONEST labels — an "insufficient" card
 * when the data cannot support a claim, never a green card conjured from absent data.
 */

// ---------------------------------------------------------------------
// The eleven Master-Plan product stages, in pipeline order. Kept beside the
// derivations so the "furthest-along" summary and the migration CHECK share one
// canonical order.
// ---------------------------------------------------------------------
export const PIPELINE_STAGES = [
  "idea",
  "research",
  "specification",
  "design",
  "engineering",
  "testing",
  "documentation",
  "marketing",
  "sales",
  "deployment",
  "review",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  idea: "Idea",
  research: "Research",
  specification: "Specification",
  design: "Design",
  engineering: "Engineering",
  testing: "Testing",
  documentation: "Documentation",
  marketing: "Marketing",
  sales: "Sales",
  deployment: "Deployment",
  review: "Review",
};

const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  PIPELINE_STAGES.map((s, i) => [s, i]),
);

// The execution lifecycle, split into ACTIVE (still moving) and TERMINAL (frozen) —
// the same split the engine's guard enforces.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set([
  "pending",
  "running",
  "blocked",
  "claimed",
  "waiting_approval",
  "verifying",
]);

function isActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}
function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------
// Health thresholds. Named constants so the bands are auditable, not magic.
// ---------------------------------------------------------------------
/** A running task whose heartbeat is older than this reads as RED (worker stalled). */
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
/** …older than this (but under STALE) reads as AMBER (worker slowing). */
const HEARTBEAT_WARN_MS = 5 * 60 * 1000;
/** Share of finished tasks that failed at/above which health is RED. */
const FAILED_RATIO_RED = 0.5;
/** …at/above which health is AMBER. */
const FAILED_RATIO_AMBER = 0.2;
/** retry_count on an ACTIVE task at/above which health is RED. */
const ACTIVE_RETRY_RED = 3;
/** …at/above which health is AMBER. */
const ACTIVE_RETRY_AMBER = 1;

// ---------------------------------------------------------------------
// Input row — a lean structural subset of an `hq_ai_tasks` row. Callers may pass a
// full row or a bounded read; only these columns are consulted.
// ---------------------------------------------------------------------
export interface BoardroomTask {
  status: string;
  verification: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  deadline_at: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  retry_count: number;
  max_retries: number;
  pipeline_stage: string | null;
}

// ---------------------------------------------------------------------
// Card shapes.
// ---------------------------------------------------------------------
export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";
export type EtaLevel = "overdue" | "scheduled" | "insufficient";
export type HealthLevel = "green" | "amber" | "red" | "insufficient";

export interface ConfidenceCard {
  level: ConfidenceLevel;
  /** 0–100 integer share of verified/passed among the judged tasks; null if insufficient. */
  pct: number | null;
  passed: number;
  failed: number;
  /** passed + failed — the number of tasks that carried a quality verdict. */
  sample: number;
}

export interface EtaCard {
  level: EtaLevel;
  /** ISO timestamp of the nearest deadline among active tasks; null if insufficient. */
  at: string | null;
  overdue: boolean;
  /** How many active tasks carry a deadline. */
  activeWithDeadline: number;
}

export interface HealthCard {
  level: HealthLevel;
  /** Human-readable, deterministic explanations for the level (worst-first). */
  reasons: string[];
}

export interface PipelineSummary {
  /** The furthest-along stage among ACTIVE tasks; null when none is staged. */
  current: PipelineStage | null;
  /** Count of active tasks per stage present. */
  counts: Partial<Record<PipelineStage, number>>;
  /** Total active tasks that carry a stage. */
  staged: number;
}

export interface EmployeeCards {
  confidence: ConfidenceCard;
  eta: EtaCard;
  health: HealthCard;
  pipeline: PipelineSummary;
}

// ---------------------------------------------------------------------
// Confidence.
// ---------------------------------------------------------------------

type Verdict = "pass" | "fail" | null;

/**
 * Read a pass/fail verdict from a `verification` jsonb payload, tolerating the shapes
 * a verifier might write. Returns null when the payload carries no recognisable
 * verdict (so the caller can fall back to the execution outcome).
 */
function verificationVerdict(v: Record<string, unknown> | null): Verdict {
  if (!v || typeof v !== "object") return null;
  if (typeof v.verified === "boolean") return v.verified ? "pass" : "fail";
  if (typeof v.passed === "boolean") return v.passed ? "pass" : "fail";
  const status = typeof v.status === "string" ? v.status.toLowerCase() : null;
  if (status) {
    if (["passed", "verified", "pass", "ok", "success"].includes(status)) return "pass";
    if (["failed", "rejected", "fail", "error"].includes(status)) return "fail";
  }
  return null;
}

/** The per-task verdict: the verification signal if present, else the terminal outcome. */
function taskVerdict(task: BoardroomTask): Verdict {
  const fromVerification = verificationVerdict(task.verification);
  if (fromVerification) return fromVerification;
  // Fall back to the execution outcome: a completed task is a pass, a failed task a
  // fail. pending/running/cancelled carry no quality signal.
  if (task.status === "completed") return "pass";
  if (task.status === "failed") return "fail";
  return null;
}

export function deriveConfidence(tasks: ReadonlyArray<BoardroomTask>): ConfidenceCard {
  let passed = 0;
  let failed = 0;
  for (const task of tasks) {
    const verdict = taskVerdict(task);
    if (verdict === "pass") passed += 1;
    else if (verdict === "fail") failed += 1;
  }
  const sample = passed + failed;
  if (sample === 0) {
    return { level: "insufficient", pct: null, passed, failed, sample };
  }
  const pct = Math.round((100 * passed) / sample);
  const level: ConfidenceLevel = pct >= 80 ? "high" : pct >= 50 ? "medium" : "low";
  return { level, pct, passed, failed, sample };
}

// ---------------------------------------------------------------------
// ETA.
// ---------------------------------------------------------------------

export function deriveEta(tasks: ReadonlyArray<BoardroomTask>, now: Date): EtaCard {
  const nowMs = now.getTime();
  let nearestMs: number | null = null;
  let count = 0;
  for (const task of tasks) {
    if (!isActive(task.status) || !task.deadline_at) continue;
    const ms = Date.parse(task.deadline_at);
    if (Number.isNaN(ms)) continue;
    count += 1;
    if (nearestMs === null || ms < nearestMs) nearestMs = ms;
  }
  if (nearestMs === null) {
    return { level: "insufficient", at: null, overdue: false, activeWithDeadline: 0 };
  }
  const overdue = nearestMs < nowMs;
  return {
    level: overdue ? "overdue" : "scheduled",
    at: new Date(nearestMs).toISOString(),
    overdue,
    activeWithDeadline: count,
  };
}

// ---------------------------------------------------------------------
// Health.
// ---------------------------------------------------------------------

export function deriveHealth(tasks: ReadonlyArray<BoardroomTask>, now: Date): HealthCard {
  if (tasks.length === 0) {
    return { level: "insufficient", reasons: ["No tasks assigned yet."] };
  }
  const nowMs = now.getTime();

  let leaseExpired = 0;
  let heartbeatStale = 0;
  let heartbeatWarn = 0;
  let maxActiveRetry = 0;
  let completed = 0;
  let failed = 0;

  for (const task of tasks) {
    if (task.status === "running") {
      if (task.lease_expires_at) {
        const exp = Date.parse(task.lease_expires_at);
        if (!Number.isNaN(exp) && exp < nowMs) leaseExpired += 1;
      }
      if (task.heartbeat_at) {
        const hb = Date.parse(task.heartbeat_at);
        if (!Number.isNaN(hb)) {
          const age = nowMs - hb;
          if (age >= HEARTBEAT_STALE_MS) heartbeatStale += 1;
          else if (age >= HEARTBEAT_WARN_MS) heartbeatWarn += 1;
        }
      }
    }
    if (isActive(task.status)) {
      maxActiveRetry = Math.max(maxActiveRetry, task.retry_count);
    }
    if (task.status === "completed") completed += 1;
    else if (task.status === "failed") failed += 1;
  }

  const finished = completed + failed;
  const failedRatio = finished > 0 ? failed / finished : null;

  // Collect every fired signal as an honest reason, then pick the worst level.
  const redReasons: string[] = [];
  const amberReasons: string[] = [];

  if (leaseExpired > 0) {
    redReasons.push(
      `${leaseExpired} running task${leaseExpired === 1 ? "" : "s"} with an expired lease (worker stalled).`,
    );
  }
  if (heartbeatStale > 0) {
    redReasons.push(
      `${heartbeatStale} running task${heartbeatStale === 1 ? "" : "s"} with no heartbeat for over 15 minutes.`,
    );
  }
  if (failedRatio !== null && failedRatio >= FAILED_RATIO_RED) {
    redReasons.push(`${Math.round(failedRatio * 100)}% of finished tasks failed.`);
  }
  if (maxActiveRetry >= ACTIVE_RETRY_RED) {
    redReasons.push(`An active task is on retry #${maxActiveRetry}.`);
  }

  if (heartbeatWarn > 0) {
    amberReasons.push(
      `${heartbeatWarn} running task${heartbeatWarn === 1 ? "" : "s"} slow to heartbeat (over 5 minutes).`,
    );
  }
  if (
    failedRatio !== null &&
    failedRatio >= FAILED_RATIO_AMBER &&
    failedRatio < FAILED_RATIO_RED
  ) {
    amberReasons.push(`${Math.round(failedRatio * 100)}% of finished tasks failed.`);
  }
  if (maxActiveRetry >= ACTIVE_RETRY_AMBER && maxActiveRetry < ACTIVE_RETRY_RED) {
    amberReasons.push(`An active task is on retry #${maxActiveRetry}.`);
  }

  if (redReasons.length > 0) {
    return { level: "red", reasons: redReasons };
  }
  if (amberReasons.length > 0) {
    return { level: "amber", reasons: amberReasons };
  }
  return { level: "green", reasons: ["No stalled leases, retries, or elevated failures."] };
}

// ---------------------------------------------------------------------
// Pipeline summary — the product axis, surfaced where present.
// ---------------------------------------------------------------------

export function derivePipeline(tasks: ReadonlyArray<BoardroomTask>): PipelineSummary {
  const counts: Partial<Record<PipelineStage, number>> = {};
  let current: PipelineStage | null = null;
  let currentIndex = -1;
  let staged = 0;

  for (const task of tasks) {
    if (!isActive(task.status)) continue;
    const stage = task.pipeline_stage;
    if (!stage || !(stage in STAGE_INDEX)) continue;
    const s = stage as PipelineStage;
    counts[s] = (counts[s] ?? 0) + 1;
    staged += 1;
    const idx = STAGE_INDEX[s]!;
    if (idx > currentIndex) {
      currentIndex = idx;
      current = s;
    }
  }

  return { current, counts, staged };
}

// ---------------------------------------------------------------------
// The one entry point the pages call.
// ---------------------------------------------------------------------

/** Derive all four boardroom views for one employee's tasks. `now` is injected. */
export function deriveEmployeeCards(
  tasks: ReadonlyArray<BoardroomTask>,
  now: Date,
): EmployeeCards {
  return {
    confidence: deriveConfidence(tasks),
    eta: deriveEta(tasks, now),
    health: deriveHealth(tasks, now),
    pipeline: derivePipeline(tasks),
  };
}

// Re-exported for callers that need the split without recomputing.
export { isActive as isActiveStatus, isTerminal as isTerminalStatus };
