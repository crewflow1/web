import type {
  AiEmployeeStatus,
  TaskStatus,
  Accent,
} from "@/lib/ai-employees/model";
import type { ApprovalLevelKey } from "@/lib/ai-employees/approval-levels";

/**
 * AI Boardroom — presentation classes (light operational system).
 *
 * Product UX rebuild (HQ phase): the Boardroom used to be a dark island —
 * `bg-slate-950`, `text-*-300` blended pills, neon accent glows, `animate-ping`.
 * It now renders on the SAME light system as the product: solid `-100`/`-800`
 * pills (AA-verified in components/ui/tokens.ts), slate chrome, no glow, no
 * opacity fills. These strings are spelled in full so Tailwind's JIT scanner
 * (which globs app / components / emails) generates them; the pure data + labels
 * live in lib/ai-employees/model.ts.
 *
 * Colour never carries meaning alone — every pill is rendered beside a text
 * label at the call site.
 */

export type StatusStyle = { dot: string; pill: string };

export const STATUS_STYLE: Record<AiEmployeeStatus, StatusStyle> = {
  idle: {
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200",
  },
  working: {
    dot: "bg-emerald-500",
    pill: "bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200",
  },
  waiting_approval: {
    dot: "bg-amber-500",
    pill: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200",
  },
  blocked: {
    dot: "bg-orange-500",
    pill: "bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200",
  },
  error: {
    dot: "bg-red-500",
    pill: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-200",
  },
  disabled: {
    dot: "bg-slate-300",
    pill: "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200",
  },
};

export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLE[(status as AiEmployeeStatus)] ?? STATUS_STYLE.idle;
}

export const TASK_STATUS_PILL: Record<TaskStatus, string> = {
  pending: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200",
  in_progress: "bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200",
  waiting_approval: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200",
  completed: "bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200",
  failed: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-200",
  cancelled: "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200",
};

export function taskStatusPill(status: string): string {
  return TASK_STATUS_PILL[(status as TaskStatus)] ?? TASK_STATUS_PILL.pending;
}

export type AccentClasses = {
  /** Icon tile background + text. */
  icon: string;
  /** Card hover ring colour (retired — kept as an empty string for API parity). */
  ring: string;
  /** Soft glow shadow on hover (retired — kept as an empty string for API parity). */
  glow: string;
  /** Accent text colour. */
  text: string;
};

/**
 * A gentle, light department accent: a `-100` icon tile with `-700` glyph. The
 * old neon `hover:shadow-*-500/20` glow + `hover:ring-*-400/40` are RETIRED
 * (empty strings) — the light card gets its definition from a plain slate
 * border + shadow-sm, like every product card.
 */
export const ACCENT_CLASSES: Record<Accent, AccentClasses> = {
  violet: { icon: "bg-violet-100 text-violet-700", ring: "", glow: "", text: "text-violet-700" },
  sky: { icon: "bg-sky-100 text-sky-700", ring: "", glow: "", text: "text-sky-700" },
  emerald: { icon: "bg-emerald-100 text-emerald-700", ring: "", glow: "", text: "text-emerald-700" },
  pink: { icon: "bg-pink-100 text-pink-700", ring: "", glow: "", text: "text-pink-700" },
  fuchsia: { icon: "bg-fuchsia-100 text-fuchsia-700", ring: "", glow: "", text: "text-fuchsia-700" },
  amber: { icon: "bg-amber-100 text-amber-700", ring: "", glow: "", text: "text-amber-700" },
  cyan: { icon: "bg-cyan-100 text-cyan-700", ring: "", glow: "", text: "text-cyan-700" },
  indigo: { icon: "bg-indigo-100 text-indigo-700", ring: "", glow: "", text: "text-indigo-700" },
  green: { icon: "bg-green-100 text-green-700", ring: "", glow: "", text: "text-green-700" },
  blue: { icon: "bg-blue-100 text-blue-700", ring: "", glow: "", text: "text-blue-700" },
  slate: { icon: "bg-slate-100 text-slate-700", ring: "", glow: "", text: "text-slate-700" },
};

export function accentClasses(accent: string): AccentClasses {
  return ACCENT_CLASSES[(accent as Accent)] ?? ACCENT_CLASSES.slate;
}

// ---------------------------------------------------------------------
// Approval-level ladder — badge classes per rung (1 Observe → 5 Autonomous).
// The pure data + labels live in lib/ai-employees/approval-levels.ts; the
// Tailwind class strings live here so the JIT scanner generates them. Colour
// climbs with autonomy — neutral at Observe, warm/alert at Autonomous — so the
// rung reads at a glance without relying on the number alone. Light system.
// ---------------------------------------------------------------------

export type ApprovalLevelStyle = { dot: string; pill: string };

export const APPROVAL_LEVEL_STYLE: Record<ApprovalLevelKey, ApprovalLevelStyle> = {
  observe: {
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200",
  },
  recommend: {
    dot: "bg-blue-500",
    pill: "bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200",
  },
  draft: {
    dot: "bg-indigo-500",
    pill: "bg-indigo-100 text-indigo-800 ring-1 ring-inset ring-indigo-200",
  },
  execute_with_approval: {
    dot: "bg-amber-500",
    pill: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200",
  },
  autonomous: {
    dot: "bg-red-500",
    pill: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-200",
  },
};

export function approvalLevelStyle(key: ApprovalLevelKey): ApprovalLevelStyle {
  return APPROVAL_LEVEL_STYLE[key] ?? APPROVAL_LEVEL_STYLE.observe;
}
