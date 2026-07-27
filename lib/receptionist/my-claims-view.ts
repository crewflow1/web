import {
  orderOwnershipEvents,
  type OwnershipEvent,
  type OwnershipSummary,
  type OwnershipStatus,
} from "./conversation-ownership-read-model";

// =====================================================================
// THE MY CLAIMS LIST — PURE VIEW CORE (CEO Directive #018, R49: MY CLAIMS LIST).
//
// R48 established the canonical Conversation Work Ownership Read Model — the single authoritative projection of ownership
// state over the append-only claim ledger (per-coordination owner + status, org-wide history, org-wide summary). R49 is
// the FIRST operator-facing surface built ON that read model: a read-only "My Claims" list showing the signed-in
// operator the conversation worklist items THEY have claimed and now own.
//
// This module is that surface's PURE CORE. It CONSUMES the read model's output — an org's ownership EVENTS
// ({@link OwnershipEvent}, from `getOwnershipHistory`) and the org's ownership SUMMARY ({@link OwnershipSummary}, from
// `getOwnershipSummary`) — and PROJECTS the viewer-relative "My Claims" view: the events FILTERED to the current
// operator (in the read model's canonical newest-first order), plus that operator's own claim tally (count + latest).
// It is total, deterministic and dependency-free: it reaches NO I/O, holds NO clock and NO RNG, RECORDS NOTHING and
// DECIDES NO CLAIM. The claim decision + write remain R46's; ownership derivation remains R48's; this core only
// re-frames R48's already-derived facts for one viewer.
//
// IT CONSUMES ONLY THE R48 READ MODEL. Its whole input is R48's projected output ({@link OwnershipEvent} +
// {@link OwnershipSummary}); it names no ledger, opens no client and re-derives no ownership. The "current operator
// ownership filtering" the surface performs is a VIEW-LEVEL narrowing of an already-org-scoped read (the reader's
// mandatory `org_id` filter is the security boundary; this filter is a presentation choice — "show me mine").
//
// IT INTRODUCES NO EXECUTION PATH. It lists claims the operator already holds; it assigns nothing, reassigns nothing,
// releases nothing, dispatches nothing, notifies no one and completes nothing — every one an explicit R49 non-goal.
// A row is a label the surface links to the existing R45 detail surface; it is not an affordance.
// =====================================================================

/**
 * ONE row of the operator's My Claims list — a conversation worklist item the viewer has claimed and now owns. Carries
 * the coordination it concerns (the reference the surface links to the R45 detail surface), the conversation it belongs
 * to (provenance, or null), the claim TIMESTAMP, and the ownership STATUS — always `owned`, because a row appears only
 * for a claim the viewer holds.
 */
export type MyClaimRow = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly claimedAt: string;
  readonly status: OwnershipStatus;
};

/**
 * The viewer's My Claims view — everything the read-only surface renders for the signed-in operator:
 *   • operatorId    — the viewer the view is projected for (the authenticated operator id).
 *   • operatorEmail — the viewer's denormalised email, from their latest recorded claim when known, else the identity
 *                     the caller supplied.
 *   • claimCount    — how many coordinations the viewer owns, from the org SUMMARY's per-owner tally (the authoritative,
 *                     uncapped count), else the number of rows when the viewer has no tally.
 *   • latestClaimAt — the viewer's most recent claim instant, from the summary tally, else null.
 *   • rows          — the viewer's claims as display rows, in the read model's canonical newest-first order.
 * A pure projection of R48's output for one viewer; it derives no claim and records nothing.
 */
export type MyClaimsView = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly claimCount: number;
  readonly latestClaimAt: string | null;
  readonly rows: readonly MyClaimRow[];
};

/**
 * The org's ownership events FILTERED to one operator, in the read model's canonical newest-first order. Pure and total:
 * it keeps only the events the operator owns and re-asserts {@link orderOwnershipEvents} so the result is deterministic
 * regardless of the input order (it does not trust the caller's arrangement). Non-mutating — `orderOwnershipEvents`
 * copies before sorting.
 */
export function selectOperatorEvents(
  events: readonly OwnershipEvent[],
  operatorId: string,
): OwnershipEvent[] {
  return orderOwnershipEvents(events.filter((event) => event.operatorId === operatorId));
}

/**
 * Project one ownership event into a My Claims display row. Pure — a straight relabelling; the status is `owned` because
 * the row exists only for a claim the viewer holds.
 */
export function projectMyClaimRow(event: OwnershipEvent): MyClaimRow {
  return {
    coordinationId: event.coordinationId,
    conversationId: event.conversationId,
    claimedAt: event.claimedAt,
    status: "owned",
  };
}

/**
 * Derive the viewer's {@link MyClaimsView} from the org's ownership events + summary and the viewer's identity. Pure and
 * total:
 *   • ROWS come from the events, filtered to the viewer and canonically ordered (newest first).
 *   • The TALLY (count + latest + email) comes from the org summary's per-owner entry for the viewer — the authoritative,
 *     order-independent, uncapped aggregate. When the viewer holds no claim they have no tally, so the count falls back
 *     to the (zero) row count, the latest to null, and the email to the caller-supplied identity.
 * It filters an already-org-scoped read to one operator; it re-derives no ownership and decides no claim.
 */
export function projectMyClaims(input: {
  operatorId: string;
  operatorEmail: string | null;
  events: readonly OwnershipEvent[];
  summary: OwnershipSummary;
}): MyClaimsView {
  const { operatorId, operatorEmail, events, summary } = input;
  const rows = selectOperatorEvents(events, operatorId).map(projectMyClaimRow);
  const tally = summary.owners.find((owner) => owner.operatorId === operatorId) ?? null;
  return {
    operatorId,
    operatorEmail: tally?.operatorEmail ?? operatorEmail,
    claimCount: tally ? tally.claimCount : rows.length,
    latestClaimAt: tally ? tally.latestClaimAt : null,
    rows,
  };
}
