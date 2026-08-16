import type {
  AiEmployeeStatus,
  TaskStatus,
  Accent,
} from "@/lib/ai-employees/model";
import type { ApprovalLevelKey } from "@/lib/ai-employees/approval-levels";

/**
 * AI Boardroom — dark-theme presentation classes.
 *
 * Lives under app/ so Tailwind's JIT scanner (which only globs
 * app / components / emails) generates these utility classes. The
 * pure data + labels live in lib/ai-employees/model.ts.
 */

export type StatusStyle = { dot: string; pill: string };

export const STATUS_STYLE: Record<AiEmployeeStatus, StatusStyle> = {
  idle: {
    dot: "bg-slate-400",
    pill: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  },
  working: {
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  },
  waiting_approval: {
    dot: "bg-amber-400",
    pill: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  },
  blocked: {
    dot: "bg-orange-400",
    pill: "bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-400/30",
  },
  error: {
    dot: "bg-red-400",
    pill: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  },
  disabled: {
    dot: "bg-slate-600",
    pill: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
  },
};

export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLE[(status as AiEmployeeStatus)] ?? STATUS_STYLE.idle;
}

export const TASK_STATUS_PILL: Record<TaskStatus, string> = {
  pending: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  in_progress: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  waiting_approval:
    "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  completed:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  cancelled: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

export function taskStatusPill(status: string): string {
  return TASK_STATUS_PILL[(status as TaskStatus)] ?? TASK_STATUS_PILL.pending;
}

export type AccentClasses = {
  /** Icon tile background + text + ring. */
  icon: string;
  /** Card hover ring colour. */
  ring: string;
  /** Soft glow shadow on hover. */
  glow: string;
  /** Accent text colour. */
  text: string;
};

export const ACCENT_CLASSES: Record<Accent, AccentClasses> = {
  violet: {
    icon: "bg-violet-500/15 text-violet-300 ring-1 ring-inset ring-violet-400/30",
    ring: "hover:ring-violet-400/40",
    glow: "hover:shadow-violet-500/20",
    text: "text-violet-300",
  },
  sky: {
    icon: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
    ring: "hover:ring-sky-400/40",
    glow: "hover:shadow-sky-500/20",
    text: "text-sky-300",
  },
  emerald: {
    icon: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
    ring: "hover:ring-emerald-400/40",
    glow: "hover:shadow-emerald-500/20",
    text: "text-emerald-300",
  },
  pink: {
    icon: "bg-pink-500/15 text-pink-300 ring-1 ring-inset ring-pink-400/30",
    ring: "hover:ring-pink-400/40",
    glow: "hover:shadow-pink-500/20",
    text: "text-pink-300",
  },
  fuchsia: {
    icon: "bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/30",
    ring: "hover:ring-fuchsia-400/40",
    glow: "hover:shadow-fuchsia-500/20",
    text: "text-fuchsia-300",
  },
  amber: {
    icon: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
    ring: "hover:ring-amber-400/40",
    glow: "hover:shadow-amber-500/20",
    text: "text-amber-300",
  },
  cyan: {
    icon: "bg-cyan-500/15 text-cyan-300 ring-1 ring-inset ring-cyan-400/30",
    ring: "hover:ring-cyan-400/40",
    glow: "hover:shadow-cyan-500/20",
    text: "text-cyan-300",
  },
  indigo: {
    icon: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
    ring: "hover:ring-indigo-400/40",
    glow: "hover:shadow-indigo-500/20",
    text: "text-indigo-300",
  },
  green: {
    icon: "bg-green-500/15 text-green-300 ring-1 ring-inset ring-green-400/30",
    ring: "hover:ring-green-400/40",
    glow: "hover:shadow-green-500/20",
    text: "text-green-300",
  },
  blue: {
    icon: "bg-blue-500/15 text-blue-300 ring-1 ring-inset ring-blue-400/30",
    ring: "hover:ring-blue-400/40",
    glow: "hover:shadow-blue-500/20",
    text: "text-blue-300",
  },
  slate: {
    icon: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
    ring: "hover:ring-slate-400/40",
    glow: "hover:shadow-slate-500/20",
    text: "text-slate-300",
  },
};

export function accentClasses(accent: string): AccentClasses {
  return ACCENT_CLASSES[(accent as Accent)] ?? ACCENT_CLASSES.slate;
}

// ---------------------------------------------------------------------
// Approval-level ladder — badge classes per rung (1 Observe → 5 Autonomous).
// The pure data + labels live in lib/ai-employees/approval-levels.ts; the
// Tailwind class strings live here so the JIT scanner generates them. Colour
// climbs with autonomy — neutral at Observe, warm/alert at Autonomous — so the
// rung reads at a glance without relying on the number alone.
// ---------------------------------------------------------------------

export type ApprovalLevelStyle = { dot: string; pill: string };

export const APPROVAL_LEVEL_STYLE: Record<ApprovalLevelKey, ApprovalLevelStyle> = {
  observe: {
    dot: "bg-slate-400",
    pill: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  },
  recommend: {
    dot: "bg-sky-400",
    pill: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  },
  draft: {
    dot: "bg-indigo-400",
    pill: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  },
  execute_with_approval: {
    dot: "bg-amber-400",
    pill: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  },
  autonomous: {
    dot: "bg-red-400",
    pill: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  },
};

export function approvalLevelStyle(key: ApprovalLevelKey): ApprovalLevelStyle {
  return APPROVAL_LEVEL_STYLE[key] ?? APPROVAL_LEVEL_STYLE.observe;
}
