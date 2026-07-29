import {
  PERMIT_TYPE_LABELS,
  type EffectiveStatus,
  type PermitType,
} from "@/lib/health-safety/permits";

/**
 * Permit-to-Work UI vocabulary — the label + tone maps, pills, shared control
 * classes and the ?saved= / ?error= copy, in one place so the register, the
 * create form and the detail page stay visually and textually consistent.
 *
 * Colour only ever *reinforces* a written label (status, type, expiry); the
 * text always carries the meaning on its own, so nothing depends on colour.
 * Tone maps are static class strings — never interpolated — so Tailwind keeps
 * every class in the build.
 */

export const PERMIT_STATUS_LABELS: Record<EffectiveStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  active: "Active",
  suspended: "Suspended",
  closed: "Closed",
  cancelled: "Cancelled",
  expired: "Expired",
  not_yet_valid: "Not yet valid",
};

export const PERMIT_STATUS_STYLES: Record<EffectiveStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-blue-100 text-blue-800",
  active: "bg-emerald-100 text-emerald-800",
  suspended: "bg-amber-100 text-amber-800",
  closed: "bg-slate-100 text-slate-600",
  cancelled: "bg-slate-100 text-slate-600", // slate-600, not 500: AA contrast on slate-100
  expired: "bg-red-100 text-red-800",
  not_yet_valid: "bg-amber-100 text-amber-900",
};

/** Per-type pill tones — distinguishable but restrained; the label does the work. */
export const PERMIT_TYPE_STYLES: Record<PermitType, string> = {
  hot_works: "bg-orange-100 text-orange-800",
  working_at_height: "bg-sky-100 text-sky-800",
  confined_space: "bg-violet-100 text-violet-800",
  excavation: "bg-amber-100 text-amber-800",
  electrical_isolation: "bg-yellow-100 text-yellow-800",
  roof_work: "bg-cyan-100 text-cyan-800",
  temporary_works: "bg-indigo-100 text-indigo-800",
  lifting_operations: "bg-teal-100 text-teal-800",
  demolition: "bg-rose-100 text-rose-800",
  asbestos: "bg-red-100 text-red-800",
  general: "bg-slate-100 text-slate-700",
};

const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

export function StatusPill({
  status,
  className = "",
}: {
  status: EffectiveStatus;
  className?: string;
}) {
  return (
    <span className={`${PILL_BASE} ${PERMIT_STATUS_STYLES[status]} ${className}`}>
      {PERMIT_STATUS_LABELS[status]}
    </span>
  );
}

export function TypePill({
  type,
  className = "",
}: {
  type: string;
  className?: string;
}) {
  const t = type as PermitType;
  const tone = PERMIT_TYPE_STYLES[t] ?? "bg-slate-100 text-slate-700";
  const label = PERMIT_TYPE_LABELS[t] ?? type;
  return <span className={`${PILL_BASE} ${tone} ${className}`}>{label}</span>;
}

/**
 * Format a stored ISO instant for display in UK site time. Expiry is compared
 * as instants elsewhere (timezone-independent); this is presentation only.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(d);
}

/** A validity window as one readable string, or a clear "not set" note. */
export function formatWindow(
  from: string | null | undefined,
  until: string | null | undefined,
): string {
  if (!from && !until) return "No validity window set";
  return `${formatDateTime(from)} → ${formatDateTime(until)}`;
}

// ---- Shared control classes (mirror the RAMS pages) ----

export const inputClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-500 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
export const labelClass = "block text-sm font-medium text-slate-800";
export const primaryBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2";
export const secondaryBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2";
export const warnBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2";
export const dangerBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border border-red-300 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2";
/** Only for controls that are ALSO really disabled (disabled/aria-disabled) — WCAG
 * exempts those, but the gate CTA's label still has to be readable while blocked,
 * so keep slate-600 (6.1:1 on slate-200), not 500 (3.7:1). */
export const disabledBtn =
  "inline-flex min-h-[44px] cursor-not-allowed items-center justify-center rounded-md bg-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600";

// ---- Banner copy for ?saved= / ?error= ----

export const ERROR_MAP: Record<string, string> = {
  bad_id: "That permit reference was invalid.",
  not_found: "That permit no longer exists, or you don't have access to it.",
  not_editable: "This permit is no longer a draft and can no longer be edited.",
  bad_transition: "That status change isn't allowed from here.",
  numbering_failed: "Couldn't allocate a permit number. Please try again.",
};

export const SAVED_MAP: Record<string, string> = {
  created: "Draft permit created. Add your control conditions, then issue it.",
  updated: "Permit saved.",
  condition: "Condition updated.",
  condition_removed: "Condition removed.",
  issued: "Permit issued. It now carries a permanent reference.",
  active: "Permit activated — work may proceed under its conditions.",
  suspended: "Permit suspended — work must pause until it is reactivated.",
  closed: "Permit closed and retained as a record.",
  cancelled: "Permit cancelled.",
};

/** Resolve a ?error= value to friendly copy, falling back to the raw message. */
export function errorMessage(raw: string | undefined): string | null {
  if (!raw) return null;
  return ERROR_MAP[raw] ?? decodeURIComponent(raw);
}

export function savedMessage(raw: string | undefined): string | null {
  if (!raw) return null;
  return SAVED_MAP[raw] ?? null;
}
