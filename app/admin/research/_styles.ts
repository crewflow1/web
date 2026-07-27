import type {
  ResearchPhase,
  ResearchProvenance,
  ResearchStepStatus,
  ResearchTaskStatus,
} from "@/lib/research/model";

/**
 * Research AI — dark-theme presentation classes (CEO Directive 005).
 *
 * Co-located under app/ so Tailwind's JIT scanner emits every literal utility
 * string used by the live run view + section pages. The lib/research layer
 * stays a pure data layer with no class strings in it.
 */

/** Per-step checklist colours, keyed by the live step status. */
export const STEP_DOT: Record<ResearchStepStatus, string> = {
  pending: "bg-slate-700 ring-1 ring-inset ring-slate-600",
  active: "bg-indigo-400 ring-4 ring-inset ring-indigo-500/30 animate-pulse",
  done: "bg-emerald-400 ring-1 ring-inset ring-emerald-300/40",
  skipped: "bg-slate-600 ring-1 ring-inset ring-slate-500/40",
  failed: "bg-red-400 ring-1 ring-inset ring-red-300/40",
};

export const STEP_LABEL_TONE: Record<ResearchStepStatus, string> = {
  pending: "text-slate-500",
  active: "text-white",
  done: "text-slate-200",
  skipped: "text-slate-500",
  failed: "text-red-300",
};

export const STEP_BADGE: Record<ResearchStepStatus, string> = {
  pending: "text-slate-500",
  active: "text-indigo-300",
  done: "text-emerald-300",
  skipped: "text-slate-500",
  failed: "text-red-300",
};

export const PHASE_PILL: Record<ResearchPhase, string> = {
  queued: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  running: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  researching: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  analysing: "bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-400/30",
  scoring: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  reasoning: "bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
};

export const STATUS_PILL: Record<ResearchTaskStatus, string> = {
  pending: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  running: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  cancelled: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export const STATUS_LABEL: Record<ResearchTaskStatus, string> = {
  pending: "Queued",
  running: "Researching",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Score → colour band for the headline number. */
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

/** How a figure was produced — honest provenance, never hidden. */
export const PROVENANCE_LABEL: Record<ResearchProvenance, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "GPT (OpenAI)",
  deterministic: "Deterministic (no model)",
};

export const PROVENANCE_PILL: Record<ResearchProvenance, string> = {
  anthropic: "bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  openai: "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  deterministic: "bg-slate-600/20 text-slate-300 ring-1 ring-inset ring-slate-500/30",
};

/** Score-factor tone (matches lib/sales/intelligence FactorTone). */
export const FACTOR_TONE: Record<string, string> = {
  positive: "text-emerald-300",
  neutral: "text-slate-300",
  negative: "text-amber-300",
  unknown: "text-slate-500",
};

export const FACTOR_BAR: Record<string, string> = {
  positive: "bg-emerald-400/80",
  neutral: "bg-sky-400/70",
  negative: "bg-amber-400/70",
  unknown: "bg-slate-700",
};
