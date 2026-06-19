import { accentClasses } from "@/components/ai-employees/styles";
import type {
  Importance,
  MemoryStatus,
  MemoryVisibility,
} from "@/lib/memory/model";
import { pillMap, type Accent } from "@/components/ui/tokens";

/**
 * Shared Memory Engine — status → pill mapping (CEO Directive 002 →
 * consolidated under 007.6).
 *
 * Colour decisions live here as `Accent` tone data; the class strings come
 * from the one design-system source (components/ui/tokens) and are
 * byte-identical under `.dark` (see __tests__/ui/tokens.test.ts). Memory-type
 * accents still reuse the AI-employee `accentClasses` palette.
 */

export { accentClasses };

const IMPORTANCE_ACCENT: Record<Importance, Accent> = {
  low: "neutral",
  normal: "sky",
  high: "amber",
  critical: "red",
};

export const IMPORTANCE_PILL: Record<Importance, string> =
  pillMap(IMPORTANCE_ACCENT);

export function importancePill(i: string): string {
  return IMPORTANCE_PILL[i as Importance] ?? IMPORTANCE_PILL.normal;
}

const STATUS_ACCENT: Record<MemoryStatus, Accent> = {
  draft: "neutral",
  active: "emerald",
  archived: "muted",
  superseded: "orange",
};

export const STATUS_PILL: Record<MemoryStatus, string> = pillMap(STATUS_ACCENT);

export function statusPill(s: string): string {
  return STATUS_PILL[s as MemoryStatus] ?? STATUS_PILL.active;
}

const VISIBILITY_ACCENT: Record<MemoryVisibility, Accent> = {
  public_hq: "emerald",
  department: "sky",
  private: "amber",
  restricted: "red",
  system: "muted",
};

export const VISIBILITY_PILL: Record<MemoryVisibility, string> =
  pillMap(VISIBILITY_ACCENT);

export function visibilityPill(v: string): string {
  return VISIBILITY_PILL[v as MemoryVisibility] ?? VISIBILITY_PILL.public_hq;
}

/** Shared form input/select classes (dark). */
export const inputCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
export const selectCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";
