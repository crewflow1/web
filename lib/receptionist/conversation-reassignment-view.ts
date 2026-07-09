import type { ReassignmentResolution } from "./conversation-reassignment";
import type { OwnershipRecord } from "./conversation-ownership-read-model";

// =====================================================================
// THE CONVERSATION WORK REASSIGNMENT SURFACE — PURE VIEW CORE (CEO Directive #018, R54: CONVERSATION WORK REASSIGNMENT
// SURFACE).
//
// R52 shipped the canonical REASSIGNMENT capability: the pure `resolveReassignment` decision, the
// `reassignConversationWork` runtime, and the append-only, ownership-guarded
// `receptionist_conversation_claim_reassignments` ledger — the single authority over TRANSFERRING ownership of a
// coordinated Conversation Worklist item from the operator who holds it to another named operator. R53 taught the
// Ownership State Engine (and the R48 Ownership Read Model above it) to fold the transfer chain into the CURRENT OWNER.
// R54 is the FIRST operator-facing use of that capability — the single authorised UI entry point for a human operator to
// transfer ownership of a Conversation Work item to another authorised operator.
//
// This module is that surface's PURE CORE: it PROJECTS what the surface displays and DERIVES what the surface may do, as
// total, deterministic functions over already-recorded ownership FACTS (the R48 read model's {@link OwnershipRecord}) and
// the organisation's authorised operator roster. It reaches NO I/O, holds NO clock and NO RNG, and — the cardinal rule
// shared with every core in this stack — it RECORDS NOTHING and DECIDES NO REASSIGNMENT. The reassignment decision is
// R52's (`resolveReassignment`), the write is R52's (`reassignConversationWork`), and the CURRENT OWNER is the R51/R53
// engine's (read THROUGH the R48 read model); this core only turns a read-back ownership record into a transfer view, and
// a runtime resolution into a display message. It introduces NO execution path: it dispatches nothing, notifies no one,
// schedules nothing and executes no business action — it is presentation logic over the R52 record and the R48 fact.
//
// THE ONE AFFORDANCE IT DERIVES IS "TRANSFER TO ANOTHER OPERATOR". It offers the transfer ONLY when the item is owned AND
// at least one OTHER authorised operator exists to receive it — a transfer must move the item to a DIFFERENT operator
// (the pure reassignment core refuses a self-transfer), so the current owner is never a destination candidate, and an
// unowned item offers no transfer at all. The surface neither claims, releases, dispatches nor completes; those are other
// increments' capabilities and explicit R54 non-goals.
//
// Two projections, each pure:
//   • projectReassignmentView     — an ownership record + the org's operator roster + the VIEWER's id → the surface's
//                                    transfer view: the CURRENT owner, whether the viewer holds it, and the destination
//                                    candidates (every authorised operator EXCEPT the current owner, labelled + ordered).
//   • describeReassignmentOutcome — a runtime {@link ReassignmentResolution} → the operator-facing result message + tone,
//                                    including the `not_owned` case (ownership changed under the operator).
// =====================================================================

// ---------------------------------------------------------------------
// The AUTHORISED OPERATOR — one member of the organisation's operator roster, the raw destination the reader supplies.
// ---------------------------------------------------------------------

/**
 * One AUTHORISED OPERATOR in the organisation — a candidate destination for a transfer, surfaced from the org's
 * membership roster by the server reader. It names the operator (id + denormalised email + display name); the reader
 * scopes the roster to the organisation, so every operator here is an authorised member of the viewer's org and none
 * other. The pure view derives the destination CANDIDATES from this roster; it selects no operator on its own.
 */
export type ReassignmentOperator = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly operatorName: string | null;
};

/**
 * One DESTINATION CANDIDATE the surface offers — an {@link ReassignmentOperator} plus the human `label` the surface
 * renders in its picker (the operator's name, else email, else id). A candidate is always an operator OTHER than the
 * current owner (a transfer must move the item), and the candidate list is deterministically ordered.
 */
export type ReassignmentCandidate = ReassignmentOperator & {
  readonly label: string;
};

/**
 * The surface's transfer view — everything the reassignment panel needs to render the current ownership and decide the
 * ONE affordance it offers (transfer ownership to another operator, only when the item is owned and a destination
 * exists):
 *   • owned                — is the item currently held by an operator at all? (a transfer needs a current owner)
 *   • currentOwnerId       — WHO holds it now (the R53 current owner: operator B after an A→B transfer), else null.
 *   • currentOwnerLabel    — how to name the current owner: "You" for the viewer, else their email (or id fallback).
 *   • viewerHoldsOwnership — does the CURRENT operator hold it? (drives "You hold this item")
 *   • reassigned           — was the current owner reached BY a prior transfer (true) rather than the original claim?
 *   • claimedAt / heldSince — WHEN the item was first claimed / WHEN the current owner took hold (display provenance).
 *   • canReassign          — may the viewer transfer it NOW? TRUE iff it is owned AND at least one OTHER operator exists.
 *   • candidates           — the destination operators (every authorised operator EXCEPT the current owner), labelled +
 *                            ordered. Empty when unowned or when no other operator exists.
 *   • summary              — a ready human sentence describing the current ownership + the transfer affordance.
 */
export type ReassignmentView = {
  readonly coordinationId: string;
  readonly owned: boolean;
  readonly currentOwnerId: string | null;
  readonly currentOwnerLabel: string | null;
  readonly viewerHoldsOwnership: boolean;
  readonly reassigned: boolean;
  readonly claimedAt: string | null;
  readonly heldSince: string | null;
  readonly canReassign: boolean;
  readonly candidates: readonly ReassignmentCandidate[];
  readonly summary: string;
};

/** How to name one operator in the picker — their display name, else their email, else their id. Total. */
function labelFor(op: ReassignmentOperator): string {
  return op.operatorName ?? op.operatorEmail ?? op.operatorId;
}

/** The deterministic candidate order — by label, then by operator id (a total, stable tiebreak). */
function compareCandidates(a: ReassignmentCandidate, b: ReassignmentCandidate): number {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.operatorId !== b.operatorId) return a.operatorId < b.operatorId ? -1 : 1;
  return 0;
}

/**
 * Derive the DESTINATION CANDIDATES from an organisation's authorised operator roster — every operator EXCEPT the one
 * named by `excludeOperatorId` (the current owner), each labelled for the picker and ordered deterministically. Pure and
 * total. This is exactly the roster-minus-owner projection {@link projectReassignmentView} folds into its view, lifted
 * out so a caller that ALREADY knows the current owner's id (the R62 queue surface, which offers the transfer only on a
 * row it has established the viewer owns) can compose the SAME candidate set without re-deriving an ownership record. It
 * selects no operator and records nothing; the excluded operator is never a candidate (a transfer must move the item to a
 * DIFFERENT operator, and the pure reassignment core refuses a self-transfer regardless), and a null `excludeOperatorId`
 * excludes no one.
 */
export function toReassignmentCandidates(
  operators: readonly ReassignmentOperator[],
  options: { excludeOperatorId: string | null },
): ReassignmentCandidate[] {
  return operators
    .filter((op) => op.operatorId !== options.excludeOperatorId)
    .map((op): ReassignmentCandidate => ({ ...op, label: labelFor(op) }))
    .sort(compareCandidates);
}

/**
 * Derive the transfer view from the read-back ownership record, the organisation's authorised operator roster and the
 * viewer's operator id. Pure and total. The current owner is the R48 read model's (folded from the R51/R53 engine's
 * transfer chain) — this core re-derives no ownership; it presents it. The ONLY affordance the surface grants is
 * transferring an OWNED item to another operator, so:
 *   • an UNOWNED item (unclaimed or released)          → `owned: false`, no candidates, `canReassign: false`;
 *   • an OWNED item with no OTHER authorised operator   → candidates empty, `canReassign: false` (no one to transfer to);
 *   • an OWNED item with ≥1 other authorised operator   → the destination candidates (the roster MINUS the current owner,
 *                                                         labelled + ordered), `canReassign: true`.
 * The current owner is NEVER a destination candidate (a transfer must move the item to a DIFFERENT operator; the pure
 * reassignment core refuses a self-transfer). It names no viewer affordance beyond the transfer, and it RECORDS no
 * reassignment — it PROJECTS ownership facts + the roster into the surface's view only.
 */
export function projectReassignmentView(input: {
  coordinationId: string;
  ownership: OwnershipRecord;
  operators: readonly ReassignmentOperator[];
  viewerOperatorId: string;
}): ReassignmentView {
  const { coordinationId, ownership, operators, viewerOperatorId } = input;

  // Unowned → there is nothing to transfer. No current owner, no candidates, no affordance.
  if (!ownership.owned || !ownership.owner) {
    return {
      coordinationId,
      owned: false,
      currentOwnerId: null,
      currentOwnerLabel: null,
      viewerHoldsOwnership: false,
      reassigned: false,
      claimedAt: null,
      heldSince: null,
      canReassign: false,
      candidates: [],
      summary: "Unowned — no operator holds this item, so there is nothing to reassign.",
    };
  }

  const owner = ownership.owner;
  const mine = owner.operatorId === viewerOperatorId;

  // The destination roster — every authorised operator EXCEPT the current owner. A transfer must move the item to a
  // DIFFERENT operator, so the current holder is filtered out; the pure reassignment core would refuse a self-transfer
  // anyway. Labelled for the picker and ordered deterministically so two reads never reorder the choices. Derived by the
  // shared {@link toReassignmentCandidates} projection so the R62 queue surface composes the identical candidate set.
  const candidates = toReassignmentCandidates(operators, { excludeOperatorId: owner.operatorId });

  const currentOwnerLabel = mine ? "You" : owner.operatorEmail ?? owner.operatorId;

  return {
    coordinationId,
    owned: true,
    currentOwnerId: owner.operatorId,
    currentOwnerLabel,
    viewerHoldsOwnership: mine,
    reassigned: ownership.reassigned,
    claimedAt: ownership.claimedAt,
    heldSince: ownership.heldSince,
    canReassign: candidates.length > 0,
    candidates,
    summary: mine
      ? "You hold this item. Select another operator to transfer ownership to."
      : `Held by ${owner.operatorEmail ?? owner.operatorId}. Select another operator to transfer ownership to.`,
  };
}

// ---------------------------------------------------------------------
// The reassignment RESULT — the runtime's resolution, humanised for the surface.
// ---------------------------------------------------------------------

/** The tone the surface uses to style a reassignment result — a closed set, one per meaningful outcome. */
export type ReassignmentActionTone = "success" | "warning" | "error";

/** The operator-facing result of a reassignment attempt — the runtime's resolution, humanised for the surface. */
export type ReassignmentActionView = {
  readonly resolution: ReassignmentResolution;
  readonly ok: boolean;
  readonly tone: ReassignmentActionTone;
  readonly message: string;
};

/**
 * Humanise a runtime {@link ReassignmentResolution} into the surface's result message. Pure and EXHAUSTIVE over the
 * closed resolution vocabulary:
 *   • reassigned  — the item now belongs to the selected operator (or the same request was replayed; idempotent).
 *   • not_owned   — the item could not be transferred: its ownership changed under the operator (it was released, or is
 *                   now held by someone other than the recorded source); nothing was written. Refresh and try again.
 *   • unavailable — the item could not be transferred (ill-shaped, unknown/cross-tenant coordination, or a write
 *                   failure); the surface invites a refresh + retry.
 */
export function describeReassignmentOutcome(
  resolution: ReassignmentResolution,
): ReassignmentActionView {
  switch (resolution) {
    case "reassigned":
      return {
        resolution,
        ok: true,
        tone: "success",
        message: "You have reassigned this item to the selected operator.",
      };
    case "not_owned":
      return {
        resolution,
        ok: false,
        tone: "warning",
        message: "This item's ownership has changed, so it could not be reassigned. Refresh and try again.",
      };
    case "unavailable":
      return {
        resolution,
        ok: false,
        tone: "error",
        message: "This item could not be reassigned. Refresh and try again.",
      };
    default: {
      // Exhaustiveness guard — a new resolution must be handled here, or the type check fails.
      const never: never = resolution;
      return never;
    }
  }
}
