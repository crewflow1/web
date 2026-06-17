import type {
  LikelihoodBand,
  PipelineStatus,
  RiskLevel,
  ScoreBand,
} from "@/lib/sales/model";

/**
 * Sales AI Platform — dark-theme presentation classes (CEO Directive 003,
 * Phase 1). Lives under app/ so Tailwind's JIT scanner (which only globs
 * app / components / emails) emits these utility classes. Keeping every
 * literal class string here means the model layer stays a pure data layer.
 */

export const STATUS_PILL: Record<PipelineStatus, string> = {
  new: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  qualified: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  outreach_ready:
    "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  contacted:
    "bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-400/30",
  replied: "bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-400/30",
  demo_booked:
    "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  won: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  lost: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  disqualified:
    "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function statusPill(s: string): string {
  return STATUS_PILL[s as PipelineStatus] ?? STATUS_PILL.new;
}

export const SCORE_PILL: Record<ScoreBand, string> = {
  hot: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  warm: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  cool: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  cold: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  unscored:
    "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function scorePill(band: ScoreBand): string {
  return SCORE_PILL[band] ?? SCORE_PILL.unscored;
}

export const LIKELIHOOD_PILL: Record<LikelihoodBand, string> = {
  very_high:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  high: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  medium: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  low: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  unknown:
    "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function likelihoodPill(b: string): string {
  return LIKELIHOOD_PILL[b as LikelihoodBand] ?? LIKELIHOOD_PILL.unknown;
}

export const RISK_PILL: Record<RiskLevel, string> = {
  low: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  medium: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  high: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  unknown:
    "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function riskPill(r: string): string {
  return RISK_PILL[r as RiskLevel] ?? RISK_PILL.unknown;
}

/** Accent colour token for a timeline event dot, by event category. */
export function eventDotClass(
  category: "interaction" | "lifecycle" | "ai_action",
): string {
  if (category === "interaction") return "bg-sky-400/80 ring-sky-400/30";
  if (category === "ai_action")
    return "bg-fuchsia-400/80 ring-fuchsia-400/30";
  return "bg-indigo-400/80 ring-indigo-400/30";
}

/** Shared form input/select/textarea classes (dark). */
export const inputCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
export const selectCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
export const textareaCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
