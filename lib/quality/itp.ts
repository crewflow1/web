/**
 * Works Quality — ITP (Inspection & Test Plan) pure domain logic.
 *
 * Deterministic, no DB, no I/O, NO AI. The rules the database enforces
 * (lifecycle, issue readiness, hold-point semantics, immutability) are expressed
 * once here so the UI, server actions and tests share a single source of truth —
 * the lib/health-safety/rams.ts convention.
 *
 * IMPORTANT — the hold-point GATE is not computed here. Its single authority is
 * the database (`works_quality_open_hold_point` + the `works_quality_plan_status`
 * view, migration 20261076): the same predicate is what stamps
 * `hold_point_breach` onto every sign-off, and a second implementation in TS
 * would be free to drift from the stamp. This module only interprets and labels
 * the numbers the view returns.
 */

export const ITP_STATUSES = ["draft", "issued", "superseded", "withdrawn"] as const;
export type ItpStatus = (typeof ITP_STATUSES)[number];

export const ITP_STATUS_LABELS: Record<ItpStatus, string> = {
  draft: "Draft",
  issued: "Current",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

/** Only a draft is editable — an issued ITP is a controlled document. */
export function isEditable(status: ItpStatus): boolean {
  return status === "draft";
}

/**
 * Allowed lifecycle transitions (mirrors tg_itp_lifecycle):
 *   draft  → issued | withdrawn
 *   issued → superseded | withdrawn
 *   else terminal.
 * `superseded` is reached by the atomic issue RPC, never by a hand transition.
 */
export function canTransition(from: ItpStatus, to: ItpStatus): boolean {
  if (from === "draft") return to === "issued" || to === "withdrawn";
  if (from === "issued") return to === "superseded" || to === "withdrawn";
  return false;
}

// ---------------------------------------------------------------------------
// Control points
// ---------------------------------------------------------------------------
export const CONTROL_POINTS = ["inspect", "witness", "approve"] as const;
export type ControlPoint = (typeof CONTROL_POINTS)[number];

export const CONTROL_POINT_META: Record<
  ControlPoint,
  { label: string; help: string; tone: string }
> = {
  inspect: {
    label: "Inspect",
    help: "We check it ourselves and record the result.",
    tone: "bg-slate-100 text-slate-700",
  },
  witness: {
    label: "Witness",
    help: "A second party is invited to watch the check (client, contract administrator, building control).",
    tone: "bg-sky-100 text-sky-800",
  },
  approve: {
    label: "Approve",
    help: "A formal acceptance is required before the works are accepted.",
    tone: "bg-violet-100 text-violet-800",
  },
};

// ---------------------------------------------------------------------------
// Sign-off results
// ---------------------------------------------------------------------------
export const SIGNOFF_RESULTS = ["pass", "pass_with_comment", "fail"] as const;
export type SignoffResult = (typeof SIGNOFF_RESULTS)[number];

export const SIGNOFF_RESULT_META: Record<
  SignoffResult,
  { label: string; tone: string; accepts: boolean }
> = {
  // `accepts` = does this result accept the works and release a hold point.
  // Mirrors the DB's `result in ('pass','pass_with_comment')` predicate exactly.
  pass: { label: "Pass", tone: "bg-emerald-100 text-emerald-800", accepts: true },
  pass_with_comment: {
    label: "Pass with comment",
    tone: "bg-amber-100 text-amber-800",
    accepts: true,
  },
  fail: { label: "Fail", tone: "bg-red-100 text-red-800", accepts: false },
};

/** A non-pass result must be explained (mirrors the DB CHECK). */
export function requiresComment(result: SignoffResult): boolean {
  return result !== "pass";
}

/** Does this result accept the works (and therefore release a hold point)? */
export function resultAccepts(result: SignoffResult): boolean {
  return SIGNOFF_RESULT_META[result].accepts;
}

// ---------------------------------------------------------------------------
// Issue readiness
// ---------------------------------------------------------------------------
export type IssueGateInput = {
  status: ItpStatus;
  title: string;
  workPackage: string;
  jobId?: string | null;
  itemCount: number;
};

/**
 * Issue readiness — an ITP may only be issued when it is a usable quality
 * document: a draft, named, scoped to a work package, bound to the job whose
 * works it governs, and carrying at least one check. Mirrors tg_itp_lifecycle's
 * issue gate; the DB is the authority, this is the friendly pre-check.
 */
export function canIssue(itp: IssueGateInput): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (itp.status !== "draft") reasons.push("Only a draft can be issued.");
  if (!itp.title?.trim()) reasons.push("A title is required.");
  if (!itp.workPackage?.trim()) reasons.push("A work package is required.");
  if (!itp.jobId) reasons.push("The plan must name the job whose works it governs.");
  if (itp.itemCount < 1) reasons.push("At least one inspection item is required.");
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// The hold-point WARN seam
// ---------------------------------------------------------------------------

/**
 * The shape the DB read-model (works_quality_plan_status) hands back.
 * `openHoldItemNumber` is the DB-authoritative gate: the lowest hold point in
 * the plan that no live accepting sign-off has released.
 */
export type PlanProgress = {
  totalItems: number;
  holdPointItems: number;
  signedOffItems: number;
  outstandingRequiredItems: number;
  openHoldPoints: number;
  failedItems: number;
  holdPointBreaches: number;
  openHoldItemNumber: number | null;
};

export type HoldPointWarning = {
  /** Stable id so the UI can key it. */
  id: "open-hold-point" | "hold-point-breach" | "failed-item";
  tone: "danger" | "warn";
  title: string;
  body: string;
};

/**
 * Turn a plan's progress into the WARN seam.
 *
 * ══ WARN, NOT BLOCK — AND WHY ══════════════════════════════════════════════
 * A hold point means work must not proceed past it until it is signed off. This
 * function produces a WARNING and nothing else: no action anywhere in this
 * domain is disabled, refused or hidden because a hold point is open.
 *
 * That follows the Health & Safety epic exactly. Its "active job with no current
 * RAMS" control shipped as a WARN signal, not a block, because blocking real
 * site work on software state is a decision the business makes, not a trigger.
 * The one place the platform DOES hard-block on safety (20260928, asset custody
 * while an inspection is overdue) is blocking a piece of PLANT whose custody the
 * platform actually controls — a categorically different thing from telling a
 * gang they may not pour concrete.
 *
 * The DB stamps the fact permanently (`hold_point_breach` on the sign-off), so
 * a proceed-past-the-gate is never lost even though it is never prevented.
 */
export function holdPointWarnings(p: PlanProgress): HoldPointWarning[] {
  const out: HoldPointWarning[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  if (p.openHoldItemNumber !== null) {
    out.push({
      id: "open-hold-point",
      tone: "danger",
      title: `Hold point ${p.openHoldItemNumber} is not signed off`,
      body:
        p.openHoldPoints > 1
          ? `${p.openHoldPoints} hold points are still open. Work should not proceed past item ${p.openHoldItemNumber} until it has been inspected and accepted.`
          : `Work should not proceed past item ${p.openHoldItemNumber} until it has been inspected and accepted.`,
    });
  }
  if (p.holdPointBreaches > 0) {
    out.push({
      id: "hold-point-breach",
      tone: "warn",
      title: `${p.holdPointBreaches} sign-${plural(p.holdPointBreaches, "off was", "offs were")} recorded past an open hold point`,
      body: "Later work was inspected while an earlier hold point was still open. Check the sequence before handover — this is recorded on the affected sign-offs.",
    });
  }
  if (p.failedItems > 0) {
    out.push({
      id: "failed-item",
      tone: "warn",
      title: `${p.failedItems} ${plural(p.failedItems, "check has", "checks have")} failed`,
      body: "A failed check stays outstanding until the works are corrected and re-inspected. Void the sign-off and record a new one after rework.",
    });
  }
  return out;
}

/** Progress as a fraction, for the register's completion column. 0 items = 0. */
export function completionPercent(p: PlanProgress): number {
  if (p.totalItems === 0) return 0;
  const done = p.totalItems - p.outstandingRequiredItems;
  return Math.max(0, Math.min(100, Math.round((done / p.totalItems) * 100)));
}

/** Is every required check accepted? (Derived — there is no `complete` status.) */
export function isFullyAccepted(p: PlanProgress): boolean {
  return p.totalItems > 0 && p.outstandingRequiredItems === 0;
}
