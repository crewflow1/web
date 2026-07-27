import { z } from "zod";

/**
 * Asset Management — Milestone 5a: maintenance domain (pure).
 *
 * The DB (20261002) hard-enforces the invariants (completed-requires-evidence,
 * RTS-requires-cleared-linked-fail via the shared predicate, cancel-requires-
 * reason, completed-frozen, same-org refs, admin-only costs). THIS module owns
 * transition LEGALITY (the documented matrix below), validation and error
 * translation — imported by the actions AND unit-tested directly.
 */

export const MAINTENANCE_TYPES = [
  "breakdown",
  "corrective",
  "preventive",
  "service",
  "calibration",
  "warranty",
] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export const MAINTENANCE_TYPE_LABELS: Record<MaintenanceType, string> = {
  breakdown: "Breakdown",
  corrective: "Corrective repair",
  preventive: "Preventive maintenance",
  service: "Scheduled service",
  calibration: "Calibration",
  warranty: "Warranty repair",
};

export const MAINTENANCE_PRIORITIES = ["low", "medium", "high"] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export const MAINTENANCE_STATUSES = [
  "reported",
  "triaged",
  "scheduled",
  "awaiting_parts",
  "in_progress",
  "awaiting_supplier",
  "ready_for_reinspection",
  "ready_for_return_to_service",
  "completed",
  "cancelled",
] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  reported: "Reported",
  triaged: "Triaged",
  scheduled: "Scheduled",
  awaiting_parts: "Awaiting parts",
  in_progress: "In progress",
  awaiting_supplier: "With supplier",
  ready_for_reinspection: "Ready for re-inspection",
  ready_for_return_to_service: "Ready to return to service",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * THE TRANSITION MATRIX (documented + unit-tested; the DB enforces the
 * invariant subset). `cancelled → reported` is the explicit reopen. Conditional
 * edges take the case context:
 *   † ready_for_return_to_service only when NO reinspection is required
 *     (otherwise the path runs through ready_for_reinspection);
 *   ‡ completed requires work evidence, and — when reinspection is required —
 *     the case must pass through the RTS gate first (never straight to done).
 */
const TRANSITIONS: Record<MaintenanceStatus, readonly MaintenanceStatus[]> = {
  reported: ["triaged", "scheduled", "in_progress", "cancelled"],
  triaged: ["scheduled", "awaiting_parts", "in_progress", "awaiting_supplier", "cancelled"],
  scheduled: ["in_progress", "awaiting_parts", "awaiting_supplier", "cancelled"],
  awaiting_parts: ["scheduled", "in_progress", "awaiting_supplier", "cancelled"],
  in_progress: [
    "awaiting_parts",
    "awaiting_supplier",
    "ready_for_reinspection",
    "ready_for_return_to_service",
    "completed",
    "cancelled",
  ],
  awaiting_supplier: ["scheduled", "awaiting_parts", "in_progress", "cancelled"],
  ready_for_reinspection: ["in_progress", "ready_for_return_to_service", "cancelled"],
  ready_for_return_to_service: ["completed", "in_progress", "cancelled"],
  completed: [],
  cancelled: ["reported"], // explicit reopen
};

export type MaintenanceCaseContext = {
  reinspectionRequired: boolean;
  workEvidencePresent: boolean;
};

export function canTransitionCase(
  from: MaintenanceStatus,
  to: MaintenanceStatus,
  ctx: MaintenanceCaseContext,
): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  // † a reinspection-required case never skips its reinspection gate.
  if (to === "ready_for_return_to_service" && from === "in_progress" && ctx.reinspectionRequired) {
    return false;
  }
  // ‡ completing always needs evidence; and a reinspection-required case must
  // arrive via the RTS gate (in_progress → completed is for simple fixes only).
  if (to === "completed") {
    if (!ctx.workEvidencePresent) return false;
    if (ctx.reinspectionRequired && from !== "ready_for_return_to_service") return false;
  }
  return true;
}

/** Throws `invalid_transition:<from>-><to>` when illegal (house convention). */
export function assertCaseTransition(
  from: MaintenanceStatus,
  to: MaintenanceStatus,
  ctx: MaintenanceCaseContext,
): void {
  if (!canTransitionCase(from, to, ctx)) {
    throw new Error(`invalid_transition:${from}->${to}`);
  }
}

export function isActiveCase(status: MaintenanceStatus): boolean {
  return status !== "completed" && status !== "cancelled";
}

/** Downtime in whole hours (UI display; both stamps required). */
export function downtimeHours(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 3_600_000);
}

// ── Validation ────────────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optUuid = z.preprocess(blankToUndefined, z.string().uuid().optional());

export const reportCaseSchema = z.object({
  asset_id: z.string().uuid(),
  case_type: z.enum(MAINTENANCE_TYPES),
  priority: z.preprocess(blankToUndefined, z.enum(MAINTENANCE_PRIORITIES).default("medium")),
  title: z.preprocess(blankToUndefined, z.string().trim().min(1, "Describe the fault").max(200)),
  description: optText(4000),
  source_inspection_id: optUuid,
  supplier_id: optUuid,
  out_of_service: z.coerce.boolean().default(false),
  reinspection_required: z.coerce.boolean().default(false),
});
export type ReportCaseInput = z.infer<typeof reportCaseSchema>;

export const caseCostsSchema = z.object({
  case_id: z.string().uuid(),
  cost_parts: z.coerce.number().min(0).max(10_000_000).default(0),
  cost_labour: z.coerce.number().min(0).max(10_000_000).default(0),
  cost_external: z.coerce.number().min(0).max(10_000_000).default(0),
  cost_notes: optText(2000),
});

// ── Error translation ─────────────────────────────────────────────────────────
export function friendlyMaintenanceError(
  code: string | undefined,
  message: string | undefined,
): string {
  if (code === "23514" || code === "check_violation") {
    if (message && /work evidence/.test(message)) {
      return "Record what work was done before completing the case.";
    }
    if (message && /requires a reason/.test(message)) {
      return "Give a reason for cancelling.";
    }
    if (message && /unresolved safety block/.test(message)) {
      return "The linked safety inspection hasn't been cleared. Record a passing re-inspection (or an admin override) first.";
    }
    if (message && /is frozen/.test(message)) {
      return "A completed case can't be changed.";
    }
    if (message && /not in org|not a member/.test(message)) {
      return "The asset, supplier or person you chose isn't in your organisation.";
    }
    return "That change isn't allowed.";
  }
  return "Couldn't save the maintenance case. Try again.";
}
