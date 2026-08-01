/**
 * Works Quality — NCR (Non-Conformance Report) pure domain logic.
 *
 * Deterministic, no DB, no I/O, NO AI. The rules the database enforces
 * (migration 20261081: the transition graph, the derived middle statuses, the
 * write-once corrective-action decision, verified closure) are expressed once
 * here so the UI, server actions and tests share a single source of truth —
 * the lib/quality/itp.ts convention.
 *
 * AN NCR IS NOT A SNAG. A snag is a defect FOUND on a walkdown; an NCR is
 * works CHECKED against an issued inspection plan that did NOT CONFORM. It is
 * anchored to a plan item (usually a failed sign-off), carries a severity and
 * a responsible party, and cannot close without a verified corrective action.
 */

export const NCR_STATUSES = [
  "open",
  "corrective_action_proposed",
  "corrective_action_approved",
  "completed",
  "closed",
  "cancelled",
] as const;
export type NcrStatus = (typeof NCR_STATUSES)[number];

export const NCR_STATUS_META: Record<NcrStatus, { label: string; tone: string }> = {
  open: { label: "Open", tone: "bg-red-100 text-red-800" },
  corrective_action_proposed: {
    label: "Action proposed",
    tone: "bg-amber-100 text-amber-800",
  },
  corrective_action_approved: {
    label: "Action approved",
    tone: "bg-sky-100 text-sky-800",
  },
  completed: { label: "Work completed", tone: "bg-violet-100 text-violet-800" },
  closed: { label: "Closed", tone: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "Cancelled", tone: "bg-slate-100 text-slate-600" },
};

/** A live NCR is one still demanding attention. */
export function isLive(status: NcrStatus): boolean {
  return status !== "closed" && status !== "cancelled";
}

/**
 * The middle edges of the graph are DERIVED from the corrective-action record
 * (the DB refuses them by hand — the crewflow.ncr_cascade marker). The UI must
 * never offer them as buttons; it offers the corrective-action forms instead.
 */
export const NCR_DERIVED_STATUSES: readonly NcrStatus[] = [
  "corrective_action_proposed",
  "corrective_action_approved",
  "completed",
];

/**
 * Allowed transitions (mirrors tg_ncr_update_guard exactly):
 *   open      → corrective_action_proposed | cancelled
 *   proposed  → corrective_action_approved | open | cancelled
 *   approved  → completed | cancelled
 *   completed → closed | cancelled
 *   closed / cancelled → terminal
 */
export function canTransition(from: NcrStatus, to: NcrStatus): boolean {
  switch (from) {
    case "open":
      return to === "corrective_action_proposed" || to === "cancelled";
    case "corrective_action_proposed":
      return to === "corrective_action_approved" || to === "open" || to === "cancelled";
    case "corrective_action_approved":
      return to === "completed" || to === "cancelled";
    case "completed":
      return to === "closed" || to === "cancelled";
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------
export const NCR_SEVERITIES = ["minor", "major", "critical"] as const;
export type NcrSeverity = (typeof NCR_SEVERITIES)[number];

export const NCR_SEVERITY_META: Record<
  NcrSeverity,
  { label: string; help: string; tone: string }
> = {
  minor: {
    label: "Minor",
    help: "Localised, correctable without affecting the programme.",
    tone: "bg-slate-100 text-slate-700",
  },
  major: {
    label: "Major",
    help: "Affects the works' acceptance — rework or concession needed.",
    tone: "bg-amber-100 text-amber-800",
  },
  critical: {
    label: "Critical",
    help: "Structural / safety-adjacent — stop and resolve before proceeding.",
    tone: "bg-red-100 text-red-800",
  },
};

// ---------------------------------------------------------------------------
// Corrective-action decisions
// ---------------------------------------------------------------------------
export const ACTION_DECISIONS = ["accepted", "rejected"] as const;
export type ActionDecision = (typeof ACTION_DECISIONS)[number];

/** A rejection must be explained (mirrors nca_rejection_reason_required). */
export function decisionRequiresReason(decision: ActionDecision): boolean {
  return decision === "rejected";
}

/**
 * What the detail page should offer next, given the NCR's status and whether a
 * proposal is pending. One derivation so every surface agrees.
 */
export function nextSteps(status: NcrStatus): {
  canPropose: boolean;
  canDecide: boolean;
  canComplete: boolean;
  canClose: boolean;
  canCancel: boolean;
} {
  return {
    canPropose: status === "open",
    canDecide: status === "corrective_action_proposed",
    canComplete: status === "corrective_action_approved",
    canClose: status === "completed",
    canCancel: isLive(status),
  };
}
