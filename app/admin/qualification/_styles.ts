import type {
  QualificationDecision,
  QualificationPhase,
  QualificationStepStatus,
  QualificationTaskStatus,
} from "@/lib/qualification/model";

/**
 * Lead Qualification AI — dark-theme presentation classes (CEO Directive 003,
 * Module 3). Mirrors app/admin/research/_styles.ts.
 *
 * Co-located under app/ so Tailwind's JIT scanner emits every literal utility
 * string used by the live run view + section pages. The lib/qualification layer
 * stays a pure data layer with no class strings in it.
 */

/** Per-step checklist colours, keyed by the live step status. */
export const STEP_DOT: Record<QualificationStepStatus, string> = {
  pending: "bg-slate-700 ring-1 ring-inset ring-slate-600",
  active: "bg-indigo-400 ring-4 ring-inset ring-indigo-500/30 animate-pulse",
  done: "bg-emerald-400 ring-1 ring-inset ring-emerald-300/40",
  skipped: "bg-slate-600 ring-1 ring-inset ring-slate-500/40",
  failed: "bg-red-400 ring-1 ring-inset ring-red-300/40",
};

export const STEP_LABEL_TONE: Record<QualificationStepStatus, string> = {
  pending: "text-slate-500",
  active: "text-white",
  done: "text-slate-200",
  skipped: "text-slate-500",
  failed: "text-red-300",
};

export const STEP_BADGE: Record<QualificationStepStatus, string> = {
  pending: "text-slate-500",
  active: "text-indigo-300",
  done: "text-emerald-300",
  skipped: "text-slate-500",
  failed: "text-red-300",
};

/** Coarse phase pill, keyed by the lifecycle phase. */
export const PHASE_PILL: Record<QualificationPhase, string> = {
  queued: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  running: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  assessing: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  deciding: "bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
};

/** Task-status pill, keyed by hq_sales_ai_tasks.status. */
export const STATUS_PILL: Record<QualificationTaskStatus, string> = {
  pending: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  running: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  cancelled: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export const STATUS_LABEL: Record<QualificationTaskStatus, string> = {
  pending: "Queued",
  running: "Qualifying",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The verdict's own colour language — the one place a qualify/disqualify call
 * is loud. Qualified is emerald (go), disqualified is rose (stop), review is
 * amber (a human decides).
 */
export const DECISION_PILL: Record<QualificationDecision, string> = {
  qualified: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  disqualified: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  review: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
};

export const DECISION_DOT: Record<QualificationDecision, string> = {
  qualified: "bg-emerald-400",
  disqualified: "bg-rose-400",
  review: "bg-amber-400",
};

export const DECISION_RING: Record<QualificationDecision, string> = {
  qualified: "ring-emerald-400/40",
  disqualified: "ring-rose-400/40",
  review: "ring-amber-400/40",
};

export const DECISION_NUMBER_TONE: Record<QualificationDecision, string> = {
  qualified: "text-emerald-300",
  disqualified: "text-rose-300",
  review: "text-amber-300",
};

/** Score → colour band for the headline number (matches Research AI). */
export function scoreTone(score: number | null): string {
  if (score == null) return "text-slate-400";
  if (score >= 75) return "text-emerald-300";
  if (score >= 55) return "text-sky-300";
  if (score >= 40) return "text-amber-300";
  return "text-slate-300";
}

export function scoreRing(score: number | null): string {
  if (score == null) return "ring-slate-700";
  if (score >= 75) return "ring-emerald-400/40";
  if (score >= 55) return "ring-sky-400/40";
  if (score >= 40) return "ring-amber-400/40";
  return "ring-slate-600";
}

/** Criterion tone (matches lib/sales/intelligence FactorTone + "unknown"). */
export const CRITERION_TONE: Record<string, string> = {
  positive: "text-emerald-300",
  neutral: "text-slate-300",
  negative: "text-amber-300",
  unknown: "text-slate-500",
};

export const CRITERION_BAR: Record<string, string> = {
  positive: "bg-emerald-400/80",
  neutral: "bg-sky-400/70",
  negative: "bg-amber-400/70",
  unknown: "bg-slate-700",
};
