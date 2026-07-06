import type { ClaimType, ClaimOutcome } from "./conversation-claim";

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — PURE CORE (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL).
//
// R46 shipped the claim CAPABILITY (the pure `resolveClaim`, the `claimConversationWork` runtime, the append-only
// `receptionist_conversation_claims` ledger); R47 shipped the first operator-facing SURFACE over it. R48 establishes
// the CANONICAL OWNERSHIP READ MODEL — the single authoritative projection of ownership state derived from the
// append-only claim ledger. Every future capability that needs to know "who owns what" (a My-Claims list, an ownership
// dashboard, an operator queue) reads THROUGH this read model and re-implements no ownership derivation of its own.
//
// This module is the read model's PURE CORE. It PROJECTS what the read model exposes as total, deterministic functions
// over already-recorded claim facts. It reaches NO I/O, holds NO clock and NO RNG, and — the cardinal rule shared with
// every core in this stack — RECORDS NOTHING and DECIDES NO CLAIM. The claim decision is R46's (`resolveClaim`), the
// write is R46's (`claimConversationWork`); this core only turns read-back ledger rows into ownership facts. It
// introduces NO execution path: it assigns nothing, reassigns nothing, releases nothing, dispatches nothing, notifies
// no one and completes nothing — it is presentation-agnostic projection over the R46 record, and nothing else.
//
// IT CONSUMES ONLY THE APPEND-ONLY CLAIM LEDGER. The read model's whole input is {@link OwnershipClaimRow} — the
// columns the ownership reader selects from `receptionist_conversation_claims`. It reads no coordination ledger, no
// sibling engine and no other table; it re-derives no coordination and re-decides no claim. Because the ledger is
// append-only and `coordination_id` is UNIQUE there, a coordination has AT MOST ONE claim row: ownership is therefore a
// pure function of that row's presence (owned) or absence (unowned), and the org-wide history is simply the set of
// claim rows, each an ownership-taken event.
//
// IT IS VIEWER-AGNOSTIC. Unlike R47's `projectClaimOwnership` (which folds in the VIEWER's identity to decide "You
// hold this" / "may I claim"), this read model states ownership FACTS with no viewer: WHO owns a coordination, WHEN
// they claimed it, and the ownership STATUS. A viewer-relative surface composes ON TOP of these facts; the read model
// itself names no viewer and grants no affordance.
//
// Five things the read model exposes, each a pure projection/fold:
//   • projectOwner          — one ledger row → the OWNER facts (who holds the claim, and when).
//   • projectOwnership      — a coordination id + its claim row (or null) → the per-coordination OWNERSHIP RECORD:
//                             the current owner, the claim timestamp and the ownership STATUS (owned / unowned).
//   • projectOwnershipEvent — one ledger row → one OWNERSHIP EVENT (an operator took ownership of a coordination).
//   • orderOwnershipEvents  — the canonical HISTORY order: newest claim first, stable tiebreak on coordination id.
//   • summariseOwnership    — a set of ledger rows → the org-wide ownership SUMMARY: total claims, distinct owners,
//                             per-owner tallies, and the latest / earliest claim instants. Order-INDEPENDENT.
// =====================================================================

// ---------------------------------------------------------------------
// The RAW claim row — exactly the columns the ownership reader selects from `receptionist_conversation_claims`.
// ---------------------------------------------------------------------

/**
 * One RAW row of the append-only claims ledger — the recorded facts of ONE operator's claim, in the shape the ownership
 * reader selects. The CHECK-pinned vocabulary means `claim_type` / `claim_outcome` / `status` always name their closed
 * sets; `conversation_id` and `correlation_id` are the ledger's nullable, best-effort provenance. This is the read
 * model's ONLY input — it consumes the claim ledger and nothing else.
 */
export type OwnershipClaimRow = {
  readonly coordination_id: string;
  readonly org_id: string;
  readonly conversation_id: string | null;
  readonly correlation_id: string | null;
  readonly operator_id: string;
  readonly operator_email: string | null;
  readonly claim_type: string;
  readonly claim_outcome: string;
  readonly status: string;
  readonly claimed_at: string;
};

// ---------------------------------------------------------------------
// Ownership STATUS — the closed vocabulary the read model derives for one coordination.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of OWNERSHIP STATUS — the recorded state of a coordination's ownership. R48 derives exactly
 * two, and they are TOTAL over the append-only ledger:
 *   • owned   — a claim row exists for the coordination; an operator holds it.
 *   • unowned — no claim row exists; no operator has taken ownership.
 * There is deliberately no "released" or "reassigned" status: the ledger records the TAKING of ownership only, and
 * release / reassignment are explicit non-goals of a later, separately-authorised increment. A closed const tuple, so
 * {@link OwnershipStatus} is exactly these members and a consumer can switch exhaustively.
 */
export const OWNERSHIP_STATES = ["owned", "unowned"] as const;

/** One ownership status a coordination can be in. */
export type OwnershipStatus = (typeof OWNERSHIP_STATES)[number];

// ---------------------------------------------------------------------
// The OWNER — who holds a coordination's claim (VIEWER-AGNOSTIC facts).
// ---------------------------------------------------------------------

/**
 * WHO holds a coordination's claim — the recorded owner, surfaced verbatim from the ledger row. Viewer-agnostic: it
 * names the operator (id + denormalised email), the CHECK-pinned claim vocabulary, and the claim TIMESTAMP. It folds
 * in no viewer identity and grants no affordance — those belong to a surface composed on top of this fact.
 */
export type OwnerView = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly claimType: ClaimType;
  readonly claimOutcome: ClaimOutcome;
  readonly claimedAt: string;
};

/** Project one raw ledger row into the OWNER facts. Pure — a straight, total relabelling of the recorded claim. */
export function projectOwner(row: OwnershipClaimRow): OwnerView {
  return {
    operatorId: row.operator_id,
    operatorEmail: row.operator_email,
    claimType: row.claim_type as ClaimType,
    claimOutcome: row.claim_outcome as ClaimOutcome,
    claimedAt: row.claimed_at,
  };
}

// ---------------------------------------------------------------------
// The per-coordination OWNERSHIP RECORD — current owner, claim timestamp, ownership status.
// ---------------------------------------------------------------------

/**
 * The authoritative ownership state of ONE coordination — the read model's answer to "who owns this item?":
 *   • status     — {@link OwnershipStatus}: `owned` when a claim exists, `unowned` when it does not.
 *   • owned      — the same fact as a boolean convenience.
 *   • owner      — the {@link OwnerView} when owned, else null (the CURRENT owner).
 *   • claimedAt  — the claim TIMESTAMP when owned, else null.
 *   • conversationId — the conversation the claimed coordination concerns (provenance), or null.
 * A pure projection of the coordination id + its (at most one) claim row; it re-derives no coordination and decides no
 * claim.
 */
export type OwnershipRecord = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly status: OwnershipStatus;
  readonly owned: boolean;
  readonly owner: OwnerView | null;
  readonly claimedAt: string | null;
};

/**
 * Derive the per-coordination {@link OwnershipRecord} from the coordination id and its claim row (or its absence).
 * Pure and total. Because `coordination_id` is UNIQUE in the append-only ledger, a coordination has AT MOST ONE claim:
 * a present row is `owned` (with the current owner and claim timestamp), an absent row is `unowned`. It names no viewer
 * and grants no affordance — it states ownership FACTS only.
 */
export function projectOwnership(input: {
  coordinationId: string;
  claim: OwnershipClaimRow | null;
}): OwnershipRecord {
  const { coordinationId, claim } = input;
  if (!claim) {
    return {
      coordinationId,
      conversationId: null,
      status: "unowned",
      owned: false,
      owner: null,
      claimedAt: null,
    };
  }
  const owner = projectOwner(claim);
  return {
    coordinationId,
    conversationId: claim.conversation_id,
    status: "owned",
    owned: true,
    owner,
    claimedAt: owner.claimedAt,
  };
}

// ---------------------------------------------------------------------
// Ownership HISTORY — one event per recorded claim, in the read model's single canonical order.
// ---------------------------------------------------------------------

/**
 * ONE ownership event — the durable fact that an operator took ownership of a coordination, at an instant. The org-wide
 * ownership HISTORY is the set of these (one per claim row), canonically ordered by {@link orderOwnershipEvents}. Each
 * event carries the coordination + conversation it concerns, the operator who took it, the CHECK-pinned claim
 * vocabulary and the claim timestamp — the recorded facts, never re-derived.
 */
export type OwnershipEvent = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly claimType: ClaimType;
  readonly claimOutcome: ClaimOutcome;
  readonly claimedAt: string;
};

/** Project one raw ledger row into an {@link OwnershipEvent}. Pure — a straight, total relabelling of recorded facts. */
export function projectOwnershipEvent(row: OwnershipClaimRow): OwnershipEvent {
  return {
    coordinationId: row.coordination_id,
    conversationId: row.conversation_id,
    operatorId: row.operator_id,
    operatorEmail: row.operator_email,
    claimType: row.claim_type as ClaimType,
    claimOutcome: row.claim_outcome as ClaimOutcome,
    claimedAt: row.claimed_at,
  };
}

/**
 * The canonical ownership-history order — NEWEST claim first (by `claimedAt`), then a stable tiebreak on
 * `coordinationId` (a TOTAL order, since `coordination_id` is UNIQUE in the ledger) so two same-instant events never
 * swap between reads. Compares INSTANTS (via `Date.parse`), never raw timestamp strings, so the same moment written in
 * different zone spellings ties and is decided by the id. Pure and total; the read model's determinism guarantee for
 * history, mirroring the R37 coordination read model's ordering.
 */
export function compareOwnershipEvents(a: OwnershipEvent, b: OwnershipEvent): number {
  const ta = Date.parse(a.claimedAt);
  const tb = Date.parse(b.claimedAt);
  if (ta !== tb) return ta < tb ? 1 : -1; // larger instant (newer) first
  if (a.coordinationId !== b.coordinationId) return a.coordinationId < b.coordinationId ? 1 : -1;
  return 0;
}

/**
 * Return a NEW array of the events in canonical (newest-first) order. Non-mutating: it copies before sorting, so a
 * caller's array is never reordered under it. This is the single definition of "the ownership history order".
 */
export function orderOwnershipEvents(events: readonly OwnershipEvent[]): OwnershipEvent[] {
  return [...events].sort(compareOwnershipEvents);
}

// ---------------------------------------------------------------------
// Ownership SUMMARY — deterministic, order-independent aggregates over a set of claim rows.
// ---------------------------------------------------------------------

/**
 * One owner's tally in the ownership summary — how many coordinations an operator owns, and when they most recently
 * took a claim. The `operatorEmail` is the denormalised attribution from that operator's LATEST claim (deterministic).
 */
export type OwnerTally = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly claimCount: number;
  readonly latestClaimAt: string;
};

/**
 * The org-wide ownership SUMMARY — aggregates over every claim row in one organisation:
 *   • totalClaims     — how many coordinations are owned (one claim row each).
 *   • distinctOwners  — how many distinct operators hold at least one claim.
 *   • owners          — the per-owner {@link OwnerTally} list, in a deterministic order (most claims first, then most
 *                       recent claim, then operator id).
 *   • latestClaimAt   — the most recent claim instant across the organisation, or null when there are none.
 *   • earliestClaimAt — the oldest claim instant across the organisation, or null when there are none.
 * A pure, ORDER-INDEPENDENT fold: the same set of rows in any order yields an identical summary.
 */
export type OwnershipSummary = {
  readonly totalClaims: number;
  readonly distinctOwners: number;
  readonly owners: readonly OwnerTally[];
  readonly latestClaimAt: string | null;
  readonly earliestClaimAt: string | null;
};

/**
 * Whether claim row `a` is strictly NEWER than `b` under a TOTAL order — by instant (`Date.parse`), then by
 * `coordination_id` (UNIQUE, so a total tiebreak). Because the order is total and content-only, the extremes it
 * selects (latest / earliest) are ORDER-INDEPENDENT: they do not depend on the row array's arrangement.
 */
function isNewerClaim(a: OwnershipClaimRow, b: OwnershipClaimRow): boolean {
  const ta = Date.parse(a.claimed_at);
  const tb = Date.parse(b.claimed_at);
  if (ta !== tb) return ta > tb;
  return a.coordination_id > b.coordination_id;
}

/** The NEWEST claim row in a non-empty set, under the total {@link isNewerClaim} order. Order-independent. */
function latestClaim(rows: readonly OwnershipClaimRow[]): OwnershipClaimRow {
  return rows.reduce((best, row) => (isNewerClaim(row, best) ? row : best));
}

/** The OLDEST claim row in a non-empty set, under the total {@link isNewerClaim} order. Order-independent. */
function earliestClaim(rows: readonly OwnershipClaimRow[]): OwnershipClaimRow {
  return rows.reduce((best, row) => (isNewerClaim(row, best) ? best : row));
}

/** The deterministic owner order — most claims first, then most-recent claim, then operator id (a total tiebreak). */
function compareOwnerTallies(a: OwnerTally, b: OwnerTally): number {
  if (a.claimCount !== b.claimCount) return b.claimCount - a.claimCount; // more claims first
  const ta = Date.parse(a.latestClaimAt);
  const tb = Date.parse(b.latestClaimAt);
  if (ta !== tb) return ta < tb ? 1 : -1; // newer latest-claim first
  if (a.operatorId !== b.operatorId) return a.operatorId < b.operatorId ? -1 : 1; // stable, total
  return 0;
}

/**
 * Fold a set of claim rows into the org-wide {@link OwnershipSummary}. Pure, total and ORDER-INDEPENDENT: rows are
 * grouped by operator, each group tallied (count + that operator's latest claim), and the owners sorted by a total
 * order — so shuffling the input never changes the output. The overall latest / earliest instants are the extremes
 * under the same total order (null when there are no claims). It aggregates recorded facts only; it derives no claim.
 */
export function summariseOwnership(rows: readonly OwnershipClaimRow[]): OwnershipSummary {
  const byOperator = new Map<string, OwnershipClaimRow[]>();
  for (const row of rows) {
    const group = byOperator.get(row.operator_id);
    if (group) group.push(row);
    else byOperator.set(row.operator_id, [row]);
  }

  const owners: OwnerTally[] = [];
  for (const [operatorId, claims] of byOperator) {
    const latest = latestClaim(claims);
    owners.push({
      operatorId,
      operatorEmail: latest.operator_email,
      claimCount: claims.length,
      latestClaimAt: latest.claimed_at,
    });
  }
  owners.sort(compareOwnerTallies);

  return {
    totalClaims: rows.length,
    distinctOwners: byOperator.size,
    owners,
    latestClaimAt: rows.length > 0 ? latestClaim(rows).claimed_at : null,
    earliestClaimAt: rows.length > 0 ? earliestClaim(rows).claimed_at : null,
  };
}
