/**
 * CrewFlow HQ — Lead Qualification Engine lifecycle + contracts
 * (CEO Directive 003, Module 3 of the HQ Sales programme).
 *
 * Server/client-safe pure layer. NO Supabase, NO server-only imports — the
 * runner (server/services/hq-qualification.ts), the live UI and the unit tests
 * all share these types, and the lifecycle reducers are unit-tested directly.
 *
 * Module 2 (Research AI) writes a transparent `ai_qualification_score` and a
 * research report, but deliberately leaves the company at status='new': nothing
 * today makes the qualify/disqualify CALL. Module 3 fills exactly that gap. It
 * reads the persisted score + signals and makes ONE explainable, DETERMINISTIC
 * verdict — qualified | disqualified | review — then (only when the company is
 * still 'new') moves it along the existing pipeline. A qualify/disqualify
 * decision must never be an opaque model call, so there is no LLM here: the
 * rubric (lib/qualification/criteria.ts) is pure, weighted, and auditable.
 *
 * Two state vocabularies live here, mirroring the Research AI template:
 *
 *   • QualificationPhase — the coarse lifecycle (Queued → Running → Assessing →
 *     Deciding → Completed / Failed). Persisted in hq_sales_ai_tasks.result.phase.
 *
 *   • QualificationStep  — the fine-grained checklist an operator watches live
 *     (lead loaded, signals gathered, criteria evaluated, decision recorded,
 *     task completed). Mirrored to result.steps for fast polling; the decisive
 *     steps are also mirrored to hq_sales_timeline_events for the audit trail.
 *
 * The verdict contract (QualificationVerdict) is honest by construction: a
 * criterion with no supporting evidence is still listed (so the operator sees
 * the gap) but marked `known: false` and excluded from the confidence; when the
 * fit score is unknown the engine holds the lead for review rather than
 * guessing. Nothing here ever fabricates a decision.
 */

import type { FactorTone } from "@/lib/sales/intelligence";
import { scoreBand, type ScoreBand } from "@/lib/sales/model";

// ---------------------------------------------------------------------
// Coarse lifecycle phase.
// ---------------------------------------------------------------------

export const QUALIFICATION_PHASES = [
  "queued",
  "running",
  "assessing",
  "deciding",
  "completed",
  "failed",
] as const;
export type QualificationPhase = (typeof QUALIFICATION_PHASES)[number];

export const QUALIFICATION_PHASE_LABELS: Record<QualificationPhase, string> = {
  queued: "Queued",
  running: "Starting up",
  assessing: "Assessing",
  deciding: "Deciding",
  completed: "Completed",
  failed: "Failed",
};

/** Coarse task status, mirroring hq_sales_ai_tasks.status. */
export type QualificationTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 0 to 1 progress for a smooth bar; the live phases advance monotonically. */
export function phaseProgress(phase: QualificationPhase): number {
  switch (phase) {
    case "queued":
      return 0.05;
    case "running":
      return 0.2;
    case "assessing":
      return 0.55;
    case "deciding":
      return 0.85;
    case "completed":
      return 1;
    case "failed":
      return 1;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------
// Fine-grained live checklist.
// ---------------------------------------------------------------------

export type QualificationStepKey =
  | "load"
  | "signals"
  | "evaluate"
  | "decision"
  | "completed";

export type QualificationStepStatus =
  | "pending"
  | "active"
  | "done"
  | "skipped"
  | "failed";

/** Static definition of every step: its label, the phase it belongs to, and
 *  the hq_sales_timeline_events.event_type the runner logs it under. Every
 *  eventType reuses an EXISTING type from lib/sales/model.ts — the engine adds
 *  work, never a new data/vocabulary surface. */
export type QualificationStepDef = {
  key: QualificationStepKey;
  label: string;
  phase: QualificationPhase;
  /** Must be a value of the hq_sales_timeline_events event_type check. */
  eventType: string;
};

export const QUALIFICATION_STEP_DEFS: ReadonlyArray<QualificationStepDef> = [
  { key: "load", label: "Lead loaded", phase: "running", eventType: "task_started" },
  { key: "signals", label: "Signals gathered", phase: "assessing", eventType: "system" },
  { key: "evaluate", label: "Criteria evaluated", phase: "assessing", eventType: "system" },
  { key: "decision", label: "Decision recorded", phase: "deciding", eventType: "scored" },
  { key: "completed", label: "Task completed", phase: "completed", eventType: "task_completed" },
];

export const QUALIFICATION_STEP_LABEL: Record<QualificationStepKey, string> =
  Object.fromEntries(QUALIFICATION_STEP_DEFS.map((s) => [s.key, s.label])) as Record<
    QualificationStepKey,
    string
  >;

export function stepDef(key: QualificationStepKey): QualificationStepDef {
  const def = QUALIFICATION_STEP_DEFS.find((s) => s.key === key);
  if (!def) throw new Error(`Unknown qualification step: ${key}`);
  return def;
}

export function phaseForStep(key: QualificationStepKey): QualificationPhase {
  return stepDef(key).phase;
}

/** Live status of one checklist step, persisted in result.steps + polled. */
export type QualificationStepState = {
  key: QualificationStepKey;
  label: string;
  status: QualificationStepStatus;
  detail: string | null;
  at: string | null;
};

/** A fresh checklist with every step pending — written when the task starts. */
export function initialSteps(): QualificationStepState[] {
  return QUALIFICATION_STEP_DEFS.map((s) => ({
    key: s.key,
    label: s.label,
    status: "pending" as QualificationStepStatus,
    detail: null,
    at: null,
  }));
}

const TERMINAL_STEP_STATUSES: ReadonlySet<QualificationStepStatus> = new Set([
  "done",
  "skipped",
  "failed",
]);

export function isStepTerminal(status: QualificationStepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}

/**
 * Pure reducer: return a new steps array with one step set to a terminal (or
 * active) status. Unknown keys are ignored so a malformed result row never
 * throws in the UI. The matching step's `at` stamp is set for terminal moves.
 */
export function applyStep(
  steps: ReadonlyArray<QualificationStepState>,
  key: QualificationStepKey,
  status: QualificationStepStatus,
  detail: string | null = null,
  at: string = new Date().toISOString(),
): QualificationStepState[] {
  return steps.map((s) =>
    s.key === key
      ? { ...s, status, detail, at: isStepTerminal(status) ? at : s.at }
      : s,
  );
}

/** Count of steps that reached a terminal status — drives the "N of M" label. */
export function completedStepCount(
  steps: ReadonlyArray<QualificationStepState>,
): number {
  return steps.filter((s) => isStepTerminal(s.status)).length;
}

// ---------------------------------------------------------------------
// The verdict — qualified | disqualified | review.
// ---------------------------------------------------------------------

export const QUALIFICATION_DECISIONS = [
  "qualified",
  "disqualified",
  "review",
] as const;
export type QualificationDecision = (typeof QUALIFICATION_DECISIONS)[number];

export const QUALIFICATION_DECISION_LABELS: Record<QualificationDecision, string> = {
  qualified: "Qualified",
  disqualified: "Disqualified",
  review: "Needs review",
};

export function decisionLabel(d: string): string {
  return QUALIFICATION_DECISION_LABELS[d as QualificationDecision] ?? d;
}

/** Tone for badge colour — reuses the shared FactorTone vocabulary. */
export function decisionTone(d: QualificationDecision): FactorTone {
  if (d === "qualified") return "positive";
  if (d === "disqualified") return "negative";
  return "neutral";
}

/**
 * The pipeline status a decision recommends. `review` recommends no move (the
 * lead is held at 'new' for a human), so it maps to null. Only ever one of the
 * two terminal-ish qualification statuses — the engine never skips ahead into
 * outreach or beyond.
 */
export type RecommendedStatus = "qualified" | "disqualified" | null;

export function recommendedStatusFor(d: QualificationDecision): RecommendedStatus {
  if (d === "qualified") return "qualified";
  if (d === "disqualified") return "disqualified";
  return null;
}

/**
 * One weighted criterion behind the verdict (the explainability contract). It
 * extends the shared reasoning-factor shape with two honesty flags:
 *   • `known`  — did this criterion have real evidence? (Unknowns are listed
 *                but excluded from confidence, never silently scored as zero.)
 *   • `passed` — did the gate pass? null when unknown or not a pass/fail gate.
 */
export type QualificationCriterion = {
  key: string;
  label: string;
  /** Relative weight in the confidence blend. */
  weight: number;
  /** 0 to 100 strength of this signal, or 0 when unknown. */
  value: number;
  known: boolean;
  passed: boolean | null;
  tone: FactorTone;
  detail: string;
};

export type QualificationVerdict = {
  decision: QualificationDecision;
  /** Band of the underlying fit score (hot/warm/cool/cold/unscored). */
  tier: ScoreBand;
  /** The fit score the verdict was made on (0 to 100), or null when unscored. */
  score: number | null;
  /** 0 to 100 share of criteria weight that was backed by real evidence. */
  confidence: number;
  /** All criteria, always present, in evaluation order. */
  criteria: QualificationCriterion[];
  /** The pipeline status this verdict recommends, or null to hold at 'new'. */
  recommendedStatus: RecommendedStatus;
  /** Short, ordered, plain-English reasons — the audit trail of the call. */
  rationale: string[];
  /** One-line human summary of the verdict. */
  summary: string;
};

// ---------------------------------------------------------------------
// Run summary + live state (persisted in result jsonb; polled by the UI).
// ---------------------------------------------------------------------

/** Headline summary of a finished run, surfaced on the live view + queue. */
export type QualificationRunSummary = {
  decision: QualificationDecision;
  tier: ScoreBand;
  score: number | null;
  confidence: number;
  criteriaKnown: number;
  criteriaTotal: number;
  /** True when the run actually moved the company's pipeline status. */
  transitioned: boolean;
};

/** What the live-polling endpoint returns to the watching UI. */
export type QualificationRunState = {
  taskId: string;
  companyId: string | null;
  companyName: string | null;
  status: QualificationTaskStatus;
  phase: QualificationPhase;
  steps: QualificationStepState[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: QualificationRunSummary | null;
};

// ---------------------------------------------------------------------
// Small shared helper.
// ---------------------------------------------------------------------

/** Band the fit score the same way the rest of the Sales AI surface does. */
export function tierFor(score: number | null): ScoreBand {
  return scoreBand(score);
}
