import type { ClaimType, ClaimOutcome, ClaimResolution } from "./conversation-claim";

// =====================================================================
// THE CONVERSATION WORK CLAIM SURFACE — PURE VIEW CORE (CEO Directive #018, R47: CONVERSATION WORK CLAIM SURFACE).
//
// R46 shipped the canonical claim capability: the pure `resolveClaim` decision, the `claimConversationWork` runtime,
// and the append-only, conflict-guarded `receptionist_conversation_claims` ledger. R47 is its FIRST operator-facing
// use — the single authorised UI entry point for a human operator to claim ownership of a Conversation Worklist item.
//
// This module is that surface's PURE CORE: it PROJECTS what the surface displays and DERIVES what the surface may do,
// as total, deterministic functions over already-recorded facts. It reaches NO I/O, holds NO clock and NO RNG, and —
// crucially — it RECORDS NOTHING and DECIDES NO CLAIM. The claim decision is R46's (`resolveClaim`), the write is
// R46's (`claimConversationWork`); this core only turns a read-back claim into an ownership view, and a runtime
// ClaimResult into a display message. It introduces NO execution path: it assigns nothing, dispatches nothing,
// notifies no one and mutates no state — it is presentation logic over the R46 record.
//
// Three projections, each pure:
//   • projectClaimOwner       — the raw ledger row the reader selects → the ownership facts (WHO holds the claim).
//   • projectClaimOwnership    — the ownership record + the VIEWER's operator id → the surface's ownership view: is it
//                                claimed, does the VIEWER hold it, and MAY the viewer claim it (only when unclaimed).
//   • describeClaimOutcome     — a runtime ClaimResolution → the operator-facing result message + tone, including the
//                                conflict case ("already claimed by another operator").
// =====================================================================

/**
 * The raw claim row the server reader selects from the append-only ledger — the columns the ownership display needs.
 * These are the recorded facts of an operator's claim; the CHECK-pinned vocabulary means `claim_type`/`claim_outcome`/
 * `status` always name their closed sets.
 */
export type ClaimOwnerRow = {
  readonly coordination_id: string;
  readonly org_id: string;
  readonly operator_id: string;
  readonly operator_email: string | null;
  readonly claim_type: string;
  readonly claim_outcome: string;
  readonly status: string;
  readonly claimed_at: string;
};

/** A recorded claim's ownership facts — the projection of one ledger row into the shape the surface displays. */
export type ClaimOwnerRecord = {
  readonly coordinationId: string;
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly claimType: ClaimType;
  readonly claimOutcome: ClaimOutcome;
  readonly status: "claimed";
  readonly claimedAt: string;
};

/** Project one raw ledger row into the ownership record. Pure — a straight, total relabelling of recorded facts. */
export function projectClaimOwner(row: ClaimOwnerRow): ClaimOwnerRecord {
  return {
    coordinationId: row.coordination_id,
    operatorId: row.operator_id,
    operatorEmail: row.operator_email,
    claimType: row.claim_type as ClaimType,
    claimOutcome: row.claim_outcome as ClaimOutcome,
    status: "claimed",
    claimedAt: row.claimed_at,
  };
}

/**
 * The surface's ownership view — everything the Detail Surface needs to render ownership and decide the ONE affordance
 * it offers (claim, only when the item is unclaimed):
 *   • claimed          — is there a recorded claim on this item at all?
 *   • viewerHoldsClaim — does the CURRENT operator hold it? (drives "You hold this claim")
 *   • canClaim         — may the viewer claim it NOW? TRUE iff it is unclaimed. The surface never offers reassignment
 *                        or release (both explicit R47 non-goals), so an already-owned item is never claimable here.
 *   • ownerLabel       — how to name the owner: "You" for the viewer, else the owner's email (or id as a fallback).
 *   • summary          — a ready human sentence describing the current ownership.
 */
export type ClaimOwnershipView = {
  readonly claimed: boolean;
  readonly canClaim: boolean;
  readonly viewerHoldsClaim: boolean;
  readonly ownerId: string | null;
  readonly ownerLabel: string | null;
  readonly claimedAt: string | null;
  readonly summary: string;
};

/**
 * Derive the ownership view from the recorded claim (or its absence) and the viewer's operator id. Pure and total.
 * The ONLY affordance the surface grants is claiming an UNCLAIMED item — there is no reassignment and no release, so
 * `canClaim` is exactly "no one holds it yet". An already-owned item (whether by the viewer or another operator) is
 * displayed, never re-claimable.
 */
export function projectClaimOwnership(input: {
  owner: ClaimOwnerRecord | null;
  viewerOperatorId: string;
}): ClaimOwnershipView {
  const { owner, viewerOperatorId } = input;
  if (!owner) {
    return {
      claimed: false,
      canClaim: true,
      viewerHoldsClaim: false,
      ownerId: null,
      ownerLabel: null,
      claimedAt: null,
      summary: "Unclaimed — no operator has taken ownership of this item yet.",
    };
  }
  const mine = owner.operatorId === viewerOperatorId;
  return {
    claimed: true,
    canClaim: false,
    viewerHoldsClaim: mine,
    ownerId: owner.operatorId,
    ownerLabel: mine ? "You" : owner.operatorEmail ?? owner.operatorId,
    claimedAt: owner.claimedAt,
    summary: mine ? "You hold this claim." : `Claimed by ${owner.operatorEmail ?? owner.operatorId}.`,
  };
}

/** The tone the surface uses to style a claim result — a closed set, one per meaningful outcome. */
export type ClaimActionTone = "success" | "warning" | "error";

/** The operator-facing result of a claim attempt — the runtime's resolution, humanised for the surface. */
export type ClaimActionView = {
  readonly resolution: ClaimResolution;
  readonly ok: boolean;
  readonly tone: ClaimActionTone;
  readonly message: string;
};

/**
 * Humanise a runtime {@link ClaimResolution} into the surface's result message. Pure and EXHAUSTIVE over the closed
 * resolution vocabulary:
 *   • claimed         — the operator now holds the item (or idempotently re-affirmed their own claim).
 *   • already_claimed — a DIFFERENT operator got there first; the conflict is reported, nothing was written.
 *   • unavailable     — the item could not be claimed (ill-shaped, unknown/cross-tenant coordination, or a write
 *                       failure); the surface invites a refresh + retry.
 */
export function describeClaimOutcome(resolution: ClaimResolution): ClaimActionView {
  switch (resolution) {
    case "claimed":
      return { resolution, ok: true, tone: "success", message: "You have claimed this item." };
    case "already_claimed":
      return {
        resolution,
        ok: false,
        tone: "warning",
        message: "This item was just claimed by another operator.",
      };
    case "unavailable":
      return {
        resolution,
        ok: false,
        tone: "error",
        message: "This item could not be claimed. Refresh and try again.",
      };
    default: {
      // Exhaustiveness guard — a new resolution must be handled here, or the type check fails.
      const never: never = resolution;
      return never;
    }
  }
}
