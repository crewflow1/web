/**
 * CrewFlow HQ — demo request lifecycle.
 *
 * Server/client-safe. The DB-side CHECK constraint (migration
 * 20260604000000_hq_shell_demos_lifecycle) allows the values listed
 * below plus the legacy strings; this list is the canonical UI order
 * for the kanban columns.
 */

export const DEMO_LIFECYCLE_STATUSES = [
  "pending_demo",
  "contacted",
  "demo_booked",
  "demo_done",
  "won",
  "lost",
  "payment_sent",
  "payment_received",
  "active_onboarding",
  "active",
] as const;

export type DemoLifecycleStatus = (typeof DEMO_LIFECYCLE_STATUSES)[number];

export const DEMO_STATUS_LABELS: Record<DemoLifecycleStatus, string> = {
  pending_demo: "New",
  contacted: "Contacted",
  demo_booked: "Demo booked",
  demo_done: "Demo done",
  won: "Won",
  lost: "Lost",
  payment_sent: "Payment sent",
  payment_received: "Payment received",
  active_onboarding: "Active (onboarding)",
  active: "Active",
};

export const DEMO_STATUS_PILL: Record<DemoLifecycleStatus, string> = {
  pending_demo: "bg-amber-100 text-amber-900 border-amber-200",
  contacted: "bg-blue-100 text-blue-900 border-blue-200",
  demo_booked: "bg-indigo-100 text-indigo-900 border-indigo-200",
  demo_done: "bg-violet-100 text-violet-900 border-violet-200",
  won: "bg-emerald-100 text-emerald-900 border-emerald-200",
  lost: "bg-red-100 text-red-800 border-red-200",
  payment_sent: "bg-orange-100 text-orange-900 border-orange-200",
  payment_received: "bg-teal-100 text-teal-900 border-teal-200",
  active_onboarding: "bg-cyan-100 text-cyan-900 border-cyan-200",
  active: "bg-emerald-200 text-emerald-950 border-emerald-300",
};

const LEGACY_MAP: Record<string, DemoLifecycleStatus> = {
  // Old enum values that predate this migration. Render them in the
  // "New" column so the operator still sees them and can move them
  // onward. They stop appearing as soon as the row gets touched.
  new: "pending_demo",
  qualified: "demo_done",
  closed_won: "won",
  closed_lost: "lost",
  approved: "won",
  rejected: "lost",
  cancelled: "lost",
};

/**
 * Map ANY status string (including legacy values) to a canonical
 * kanban column. Unknown values fall through to `pending_demo` so
 * nothing disappears off the board.
 */
export function toLifecycleStatus(raw: string | null | undefined): DemoLifecycleStatus {
  if (!raw) return "pending_demo";
  if ((DEMO_LIFECYCLE_STATUSES as readonly string[]).includes(raw)) {
    return raw as DemoLifecycleStatus;
  }
  return LEGACY_MAP[raw] ?? "pending_demo";
}

export function isValidLifecycleStatus(s: string): s is DemoLifecycleStatus {
  return (DEMO_LIFECYCLE_STATUSES as readonly string[]).includes(s);
}
