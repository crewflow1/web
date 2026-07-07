import type { ClaimType, ClaimOutcome } from "./conversation-claim";
import {
  deriveOwnershipState,
  isOwnedState,
  type OwnershipClaimEvent,
  type OwnershipReleaseEvent,
} from "./conversation-ownership-state";

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — PURE CORE (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL; delegating to the Ownership State Engine since R51: CONVERSATION OWNERSHIP STATE ENGINE).
//
// R46 shipped the claim CAPABILITY (the pure `resolveClaim`, the `claimConversationWork` runtime, the append-only
// `receptionist_conversation_claims` ledger); R47 shipped the first operator-facing SURFACE over it; R50 added the
// RELEASE capability + its append-only ledger. R48 established the CANONICAL OWNERSHIP READ MODEL — the authoritative
// VIEW of ownership over those ledgers. R51 established the canonical OWNERSHIP STATE ENGINE beneath it: the single
// authority that DERIVES ownership state (`unclaimed` / `claimed` / `released`) from the append-only event stream. Since
// R51 the read model is a pure CONSUMER of that engine — it re-implements NO ownership derivation of its own; it asks the
// engine for the state and PROJECTS it into the read model's views. Every capability that needs to know "who owns what"
// (a My-Claims list, an ownership dashboard, an operator queue) reads THROUGH this read model, which reads through the
// engine.
//
// This module is the read model's PURE CORE. It PROJECTS what the read model exposes as total, deterministic functions
// over already-recorded ownership facts. It reaches NO I/O, holds NO clock and NO RNG, and — the cardinal rule shared
// with every core in this stack — RECORDS NOTHING, DECIDES NO CLAIM and DECIDES NO RELEASE. The claim decision + write
// are R46's (`resolveClaim` / `claimConversationWork`); the release decision + write are R50's (`resolveRelease` /
// `releaseConversationWork`); the ownership-state derivation is R51's ({@link deriveOwnershipState}); this core only
// PROJECTS the engine's state into views. It introduces NO execution path: it assigns nothing, reassigns nothing,
// dispatches nothing, notifies no one and completes nothing, and it neither claims nor releases anything — it is
// presentation-agnostic projection over the engine's state, and nothing else.
//
// OWNERSHIP DERIVATION LIVES IN THE ENGINE, NOT HERE. The read model's owned/unowned STATUS and its "active claim"
// selection both DELEGATE to the R51 engine ({@link deriveOwnershipState} / {@link isOwnedState}) — owned IFF the engine
// derives `claimed`; a claim is active IFF the engine derives `claimed` from it and its (matching) release. The read
// model's inputs are the engine's event shapes: {@link OwnershipClaimRow} (a claim event, aliased from the engine's
// `OwnershipClaimEvent`) and {@link OwnershipReleaseRow} (a release event, aliased from `OwnershipReleaseEvent`). It
// reads no coordination ledger, no sibling engine and no other table; it re-derives no coordination and re-decides no
// ownership. A released item returns to the unclaimed state in the ENGINE's derivation, which this core projects.
//
// IT IS VIEWER-AGNOSTIC. Unlike R47's `projectClaimOwnership` (which folds in the VIEWER's identity to decide "You
// hold this" / "may I claim"), this read model states ownership FACTS with no viewer: WHO owns a coordination, WHEN
// they claimed it, and the ownership STATUS. A viewer-relative surface composes ON TOP of these facts; the read model
// itself names no viewer and grants no affordance.
//
// Five things the read model exposes, each a pure projection/fold over the engine's state + events:
//   • projectOwner          — one claim event → the OWNER facts (who holds the claim, and when).
//   • projectOwnership      — a coordination id + its claim/release events → the per-coordination OWNERSHIP RECORD: the
//                             current owner, the claim timestamp and the ownership STATUS (owned / unowned), the STATUS
//                             derived by the engine.
//   • projectOwnershipEvent — one claim event → one OWNERSHIP EVENT (an operator took ownership of a coordination).
//   • orderOwnershipEvents  — the canonical HISTORY order: newest claim first, stable tiebreak on coordination id.
//   • summariseOwnership    — a set of claim events → the org-wide ownership SUMMARY: total claims, distinct owners,
//                             per-owner tallies, and the latest / earliest claim instants. Order-INDEPENDENT.
// =====================================================================

// ---------------------------------------------------------------------
// The RAW ownership events — the engine's canonical event shapes, re-exported as the read model's row inputs.
// ---------------------------------------------------------------------

/**
 * One RAW row of the append-only claims ledger — the recorded facts of ONE operator's claim, in the shape the state
 * engine reads. Since R51 the canonical shape lives in the Ownership State Engine as {@link OwnershipClaimEvent}; the
 * read model aliases it so there is a SINGLE definition of a claim event and the read model provably consumes the
 * engine's shape. The CHECK-pinned vocabulary means `claim_type` / `claim_outcome` / `status` always name their closed
 * sets; `conversation_id` and `correlation_id` are the nullable, best-effort provenance.
 */
export type OwnershipClaimRow = OwnershipClaimEvent;

/**
 * One RAW row of the append-only RELEASE ledger — the recorded fact that ONE operator RELINQUISHED their claim on a
 * coordination (R50), in the shape the state engine reads. Since R51 the canonical shape lives in the Ownership State
 * Engine as {@link OwnershipReleaseEvent}; the read model aliases it. The read model consumes releases to SUBTRACT them
 * from ownership: a coordination with a release event is NO LONGER owned, even though its append-only claim event still
 * exists. `coordination_id` is the load-bearing anchor (UNIQUE in the release ledger too, so a coordination has at most
 * one release); the rest is provenance carried for a faithful row shape.
 */
export type OwnershipReleaseRow = OwnershipReleaseEvent;

// ---------------------------------------------------------------------
// Ownership STATUS — the closed vocabulary the read model derives for one coordination.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of OWNERSHIP STATUS — the read model's VIEW of a coordination's ownership, a two-member
 * PROJECTION of the engine's three-member lifecycle ({@link isOwnedState}). They are TOTAL:
 *   • owned   — the engine derives `claimed`; an operator holds it now.
 *   • unowned — the engine derives `unclaimed` (never taken) OR `released` (relinquished, free again).
 * The read model deliberately collapses the lifecycle's `unclaimed` and `released` into `unowned`: for "who owns this?"
 * both mean "no current owner". The finer three-state lifecycle lives in the R51 Ownership State Engine; reassignment,
 * dispatch and the rest remain explicit non-goals of later, separately-authorised increments. A closed const tuple, so
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
 * Project the per-coordination {@link OwnershipRecord} from the coordination id, its claim event (or its absence) and,
 * since R50, its release event (or its absence). Pure and total. The ownership STATUS is DERIVED BY THE ENGINE, not
 * here: it asks {@link deriveOwnershipState} for the coordination's lifecycle state and {@link isOwnedState} whether that
 * state is owned — so the read model re-decides no ownership. Because the engine derives `claimed` (the only owned
 * state) exactly when a claim event is present and no release event is, the record is a total projection:
 *   • engine derives `unclaimed` (no claim)             → `unowned` (no operator ever took it);
 *   • engine derives `released`  (a claim AND a release) → `unowned` (its owner RELINQUISHED it — free again);
 *   • engine derives `claimed`   (a claim, no release)   → `owned` (with the current owner and claim timestamp).
 * The `release` argument is OPTIONAL and defaults to absent. It names no viewer and grants no affordance — it PROJECTS
 * ownership FACTS only, and it RECORDS neither a claim nor a release.
 */
export function projectOwnership(input: {
  coordinationId: string;
  claim: OwnershipClaimRow | null;
  release?: OwnershipReleaseRow | null;
}): OwnershipRecord {
  const { coordinationId, claim, release } = input;
  // The STATUS is the engine's — owned IFF it derives `claimed`. A released item carries no CURRENT owner, so its record
  // is the same fully-null unowned shape as a never-claimed item — ownership is the present fact, not the history. The
  // `!claim` is a type-narrowing the engine's `claimed` result already implies (never taken when owned).
  const state = deriveOwnershipState({ claim, release });
  if (!isOwnedState(state) || !claim) {
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

/**
 * The ACTIVE claims in a set — the claims whose coordination the ENGINE derives as still `claimed` (R50/R51). Given the
 * org's claim events and its release events, it returns exactly the claims that still represent CURRENT ownership: for
 * each claim it asks {@link deriveOwnershipState} for the coordination's state (folding in that coordination's release,
 * if any) and keeps it only when the engine derives `claimed`. So the read model SUBTRACTS releases from ownership
 * through the SAME single derivation {@link projectOwnership} uses per coordination — the engine's, not a rule of its
 * own.
 *
 * Pure, total and ORDER-INDEPENDENT: it consults a per-coordination map of releases, so shuffling either input never
 * changes the output. Non-mutating — it returns a NEW array and never reorders the caller's. A claim with no matching
 * release passes through verbatim; a released claim is dropped.
 */
export function selectActiveClaims(
  claims: readonly OwnershipClaimRow[],
  releases: readonly OwnershipReleaseRow[],
): OwnershipClaimRow[] {
  const releaseByCoordination = new Map(
    releases.map((release) => [release.coordination_id, release] as const),
  );
  return claims.filter(
    (claim) =>
      deriveOwnershipState({
        claim,
        release: releaseByCoordination.get(claim.coordination_id) ?? null,
      }) === "claimed",
  );
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
