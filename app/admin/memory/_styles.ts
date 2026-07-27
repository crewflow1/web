import { accentClasses } from "../ai-boardroom/_styles";
import type {
  Importance,
  MemoryStatus,
  MemoryVisibility,
} from "@/lib/memory/model";

/**
 * Shared Memory Engine — dark-theme presentation classes (CEO Directive
 * 002, Phase 2). Lives under app/ so Tailwind's JIT scanner (which only
 * globs app / components / emails) emits these utility classes.
 *
 * Memory-type accents reuse the AI Boardroom palette (`accentClasses`)
 * so the two HQ surfaces share one colour vocabulary — no duplication.
 */

export { accentClasses };

export const IMPORTANCE_PILL: Record<Importance, string> = {
  low: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  normal: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  high: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  critical: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
};

export function importancePill(i: string): string {
  return IMPORTANCE_PILL[i as Importance] ?? IMPORTANCE_PILL.normal;
}

export const STATUS_PILL: Record<MemoryStatus, string> = {
  draft: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  active:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  archived:
    "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
  superseded:
    "bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-400/30",
};

export function statusPill(s: string): string {
  return STATUS_PILL[s as MemoryStatus] ?? STATUS_PILL.active;
}

export const VISIBILITY_PILL: Record<MemoryVisibility, string> = {
  public_hq:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  department: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  private: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  restricted: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  system: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function visibilityPill(v: string): string {
  return VISIBILITY_PILL[v as MemoryVisibility] ?? VISIBILITY_PILL.public_hq;
}

/** Shared form input/select classes (dark). */
export const inputCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
export const selectCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
