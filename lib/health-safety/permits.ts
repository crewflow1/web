/**
 * Health & Safety — Permit-to-Work pure domain logic. Deterministic, no DB/IO —
 * the same lifecycle, issue-gate and derived-expiry rules the DB enforces
 * (20261019), expressed once for the UI, actions and tests. A permit is an
 * operational safety record, not legal advice.
 */

export const PERMIT_TYPES = [
  "hot_works", "working_at_height", "confined_space", "excavation",
  "electrical_isolation", "roof_work", "temporary_works", "lifting_operations",
  "demolition", "asbestos", "general",
] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];

export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  hot_works: "Hot works",
  working_at_height: "Working at height",
  confined_space: "Confined space",
  excavation: "Excavation",
  electrical_isolation: "Electrical isolation / LOTO",
  roof_work: "Roof work",
  temporary_works: "Temporary works",
  lifting_operations: "Lifting operations",
  demolition: "Demolition",
  asbestos: "Asbestos-related controlled work",
  general: "General / custom",
};

export const PERMIT_STATUSES = ["draft", "issued", "active", "suspended", "closed", "cancelled"] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];

/** Only a draft is freely editable (contractual fields freeze on issue). */
export function isEditable(status: PermitStatus): boolean {
  return status === "draft";
}

/** Terminal states — no further transition. */
export function isTerminal(status: PermitStatus): boolean {
  return status === "closed" || status === "cancelled";
}

/** The transition matrix — mirrors the DB `tg_permit_lifecycle` trigger. */
export function canTransition(from: PermitStatus, to: PermitStatus): boolean {
  switch (from) {
    case "draft": return to === "issued" || to === "cancelled";
    case "issued": return to === "active" || to === "suspended" || to === "closed" || to === "cancelled";
    case "active": return to === "suspended" || to === "closed" || to === "cancelled";
    case "suspended": return to === "active" || to === "closed" || to === "cancelled";
    default: return false; // closed / cancelled are terminal
  }
}

/**
 * A permit is only valid BETWEEN valid_from and valid_until. Expiry is derived,
 * never stored: a live permit whose window has passed is "expired" and must not
 * be treated as valid. `now` is injected so this stays pure/testable.
 */
export function isExpired(
  validUntil: string | null,
  status: PermitStatus,
  now: Date,
): boolean {
  if (validUntil === null) return false;
  if (status !== "issued" && status !== "active") return false;
  return new Date(validUntil).getTime() < now.getTime();
}

export function isNotYetValid(validFrom: string | null, now: Date): boolean {
  if (validFrom === null) return false;
  return new Date(validFrom).getTime() > now.getTime();
}

export type EffectiveStatus = PermitStatus | "expired";

/** What to SHOW: the stored status, unless a live permit's window has passed. */
export function effectiveStatus(
  status: PermitStatus,
  validUntil: string | null,
  now: Date,
): EffectiveStatus {
  return isExpired(validUntil, status, now) ? "expired" : status;
}

export type ConditionState = { required: boolean; confirmed: boolean };

/**
 * Issue readiness — a permit may only be issued when it is a complete, controlled
 * authorisation: a draft, with type/title/scope, a validity window, and EVERY
 * required condition confirmed (the DB re-enforces the condition gate on issue).
 */
export function canIssue(
  permit: { status: PermitStatus; permit_type?: string | null; title?: string | null; scope?: string | null; valid_from?: string | null; valid_until?: string | null },
  conditions: ConditionState[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (permit.status !== "draft") reasons.push("Only a draft permit can be issued.");
  if (!permit.permit_type) reasons.push("A permit type is required.");
  if (!permit.title?.trim()) reasons.push("A title is required.");
  if (!permit.scope?.trim()) reasons.push("A scope of work is required.");
  if (!permit.valid_from || !permit.valid_until) reasons.push("A validity window (from / until) is required.");
  if (permit.valid_from && permit.valid_until && new Date(permit.valid_until) <= new Date(permit.valid_from)) {
    reasons.push("The permit must expire after it becomes valid.");
  }
  const outstanding = conditions.filter((c) => c.required && !c.confirmed).length;
  if (outstanding > 0) reasons.push(`${outstanding} required condition${outstanding === 1 ? "" : "s"} not yet confirmed.`);
  return { ok: reasons.length === 0, reasons };
}

export type PermitInput = {
  permitType: string;
  title: string;
  scope: string;
  location?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
};

export function validatePermit(p: PermitInput): string[] {
  const errs: string[] = [];
  if (!(PERMIT_TYPES as readonly string[]).includes(p.permitType)) errs.push("A valid permit type is required.");
  if (!p.title?.trim()) errs.push("Title is required.");
  if (!p.scope?.trim()) errs.push("Scope of work is required.");
  if (p.validFrom && p.validUntil && new Date(p.validUntil) <= new Date(p.validFrom)) {
    errs.push("Valid-until must be after valid-from.");
  }
  return errs;
}

/** Default control-condition checklists per permit type (starting points the
 *  operator can edit). Not legal advice — a competent person tailors them. */
export const DEFAULT_CONDITIONS: Partial<Record<PermitType, string[]>> = {
  hot_works: ["Fire watch in place", "Extinguisher present", "Combustibles removed / protected", "Area gas-free", "Post-work fire check (60 min)"],
  working_at_height: ["Edge protection / guardrails", "Access equipment inspected", "Fall arrest where required", "Exclusion zone below", "Weather suitable"],
  confined_space: ["Atmosphere tested (O₂ / toxic / flammable)", "Ventilation in place", "Rescue plan + standby person", "Communications established", "Entry/exit controlled"],
  excavation: ["Buried services located (CAT scan)", "Shoring / battering to spec", "Edge protection", "Access ladder", "Spoil set back from edge"],
  electrical_isolation: ["Isolated at source", "Locked off (LOTO)", "Proved dead", "Caution notices posted", "Discharge / earth applied where needed"],
  lifting_operations: ["Lift plan approved", "Equipment / accessories certified", "Exclusion zone", "Competent slinger / signaller", "Ground / outriggers assessed"],
};
