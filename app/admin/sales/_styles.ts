import type {
  LikelihoodBand,
  PipelineStatus,
  RiskLevel,
  ScoreBand,
} from "@/lib/sales/model";
import type { CallStatus, CallTone } from "@/lib/sales/calling";
import { pillMap, type Accent } from "@/components/ui/tokens";

/**
 * Sales AI Platform — status → pill mapping (CEO Directive 003 → consolidated
 * under 007.6).
 *
 * The colour *decisions* live here as `Accent` tone data; the class strings
 * come from the one design-system source (components/ui/tokens). HQ renders
 * under `.dark`, where every pill is byte-identical to the recipe this surface
 * shipped with — proven in __tests__/ui/tokens.test.ts. The exported maps +
 * helpers keep their original shapes, so no call site changes.
 */

const STATUS_ACCENT: Record<PipelineStatus, Accent> = {
  new: "neutral",
  qualified: "sky",
  outreach_ready: "indigo",
  contacted: "violet",
  replied: "cyan",
  demo_booked: "amber",
  won: "emerald",
  lost: "red",
  disqualified: "muted",
};

export const STATUS_PILL: Record<PipelineStatus, string> = pillMap(STATUS_ACCENT);

export function statusPill(s: string): string {
  return STATUS_PILL[s as PipelineStatus] ?? STATUS_PILL.new;
}

const SCORE_ACCENT: Record<ScoreBand, Accent> = {
  hot: "emerald",
  warm: "amber",
  cool: "sky",
  cold: "neutral",
  unscored: "muted",
};

export const SCORE_PILL: Record<ScoreBand, string> = pillMap(SCORE_ACCENT);

export function scorePill(band: ScoreBand): string {
  return SCORE_PILL[band] ?? SCORE_PILL.unscored;
}

const LIKELIHOOD_ACCENT: Record<LikelihoodBand, Accent> = {
  very_high: "emerald",
  high: "sky",
  medium: "amber",
  low: "neutral",
  unknown: "muted",
};

export const LIKELIHOOD_PILL: Record<LikelihoodBand, string> =
  pillMap(LIKELIHOOD_ACCENT);

export function likelihoodPill(b: string): string {
  return LIKELIHOOD_PILL[b as LikelihoodBand] ?? LIKELIHOOD_PILL.unknown;
}

const RISK_ACCENT: Record<RiskLevel, Accent> = {
  low: "emerald",
  medium: "amber",
  high: "red",
  unknown: "muted",
};

export const RISK_PILL: Record<RiskLevel, string> = pillMap(RISK_ACCENT);

export function riskPill(r: string): string {
  return RISK_PILL[r as RiskLevel] ?? RISK_PILL.unknown;
}

/**
 * Calling Centre (Phase 6) — call-status + a generic positive/neutral/negative
 * tone the outcome + sentiment pills share.
 */
const CALL_STATUS_ACCENT: Record<CallStatus, Accent> = {
  queued: "neutral",
  scheduled: "indigo",
  in_progress: "amber",
  completed: "emerald",
  no_answer: "neutral",
  voicemail: "sky",
  busy: "amber",
  failed: "red",
  cancelled: "muted",
};

export const CALL_STATUS_PILL: Record<CallStatus, string> =
  pillMap(CALL_STATUS_ACCENT);

export function callStatusPill(s: string): string {
  return CALL_STATUS_PILL[s as CallStatus] ?? CALL_STATUS_PILL.queued;
}

const CALL_TONE_ACCENT: Record<CallTone, Accent> = {
  positive: "emerald",
  neutral: "neutral",
  negative: "red",
};

export const CALL_TONE_PILL: Record<CallTone, string> = pillMap(CALL_TONE_ACCENT);

export function tonerPill(tone: CallTone): string {
  return CALL_TONE_PILL[tone] ?? CALL_TONE_PILL.neutral;
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
