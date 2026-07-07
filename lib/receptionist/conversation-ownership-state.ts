// =====================================================================
// THE CONVERSATION OWNERSHIP STATE ENGINE — PURE CORE (CEO Directive #018, R51: CONVERSATION OWNERSHIP STATE ENGINE).
//
// R46 shipped the CLAIM capability (an operator TAKES ownership of a coordinated Conversation Worklist item, recorded in
// the append-only `receptionist_conversation_claims` ledger); R50 shipped the RELEASE capability (that operator
// RELINQUISHES it, recorded in the append-only `receptionist_conversation_claim_releases` ledger). Together those two
// ledgers are the APPEND-ONLY OWNERSHIP EVENT STREAM. Until R51, ownership was DERIVED from that stream in more than one
// place — the R48 read model projected it, and its reader folded the two ledgers itself. R51 establishes the single
// canonical authority: the OWNERSHIP STATE ENGINE. It is the ONE place ownership state is derived from the event stream,
// and every consumer (the Ownership Read Model above all) reads ownership state THROUGH it and re-implements no
// derivation of its own.
//
// This module is the engine's PURE CORE — the derivation itself, as total, deterministic, dependency-free functions over
// already-recorded ownership events. It reaches NO I/O, holds NO clock and NO RNG, imports NOTHING, and — the cardinal
// rule of every core in this stack — RECORDS NOTHING, DECIDES NO CLAIM and DECIDES NO RELEASE. The claim decision +
// write are R46's (`resolveClaim` / `claimConversationWork`); the release decision + write are R50's (`resolveRelease` /
// `releaseConversationWork`); this core only FOLDS read-back events into ownership state. It introduces NO execution
// path: it assigns nothing, reassigns nothing, dispatches nothing, notifies no one, schedules nothing and completes
// nothing — it is a fold from events to a state, and nothing else.
//
// THE STATE IS A CLOSED THREE-MEMBER LIFECYCLE — Unclaimed, Claimed, Released. It is derived from the two append-only
// events of ONE coordination and NOTHING ELSE:
//   • no claim event                    → `unclaimed` (no operator has ever taken it);
//   • a claim event, no release event    → `claimed`   (an operator holds it now);
//   • a claim event AND a release event  → `released`  (its holder relinquished it — it is free to be claimed again).
// Because `coordination_id` is UNIQUE in BOTH ledgers, a coordination has AT MOST ONE claim event and AT MOST ONE release
// event, so the derivation is a TOTAL function of that (at most one, at most one) pair. The lifecycle is deliberately
// small: reassignment, dispatch, scheduling and the rest are explicit non-goals of later, separately-authorised
// increments — the engine states WHERE a coordination is in the claim⇄release lifecycle, and grants no affordance.
//
// THE ENGINE IS VIEWER-AGNOSTIC AND PRESENTATION-AGNOSTIC. It states the ownership STATE as a FACT — it folds in no
// viewer identity, no owned/unowned rendering, no history ordering and no summary. Those are the READ MODEL's concern, a
// projection composed ON TOP of this state (owned ⟺ claimed; unowned ⟺ unclaimed OR released). The engine names no
// surface and no consumer.
//
// What the engine exposes, each a pure fold/predicate/projection over the event stream:
//   • deriveOwnershipState     — a coordination's (claim?, release?) events → its {@link OwnershipState}. THE derivation.
//   • isUnclaimed / isClaimed / isReleased — total predicates over a derived state (a consumer switches exhaustively).
//   • isOwnedState             — the canonical owned/unowned projection of the lifecycle (owned IFF `claimed`).
//   • projectOwnershipState    — a coordination id + its events → its {@link OwnershipStateRecord} (state + the events).
//   • reconcileOwnershipStates — an org's claim events + release events → one state record per claimed coordination.
// =====================================================================

// ---------------------------------------------------------------------
// The append-only OWNERSHIP EVENTS — the raw rows of the two ledgers, in the shape the state runtime reads.
// ---------------------------------------------------------------------

/**
 * One CLAIM event — the durable fact that an operator TOOK ownership of a coordination, in the shape the state runtime
 * selects from `receptionist_conversation_claims` (R46). This is the FIRST of the engine's two inputs. The CHECK-pinned
 * vocabulary means `claim_type` / `claim_outcome` / `status` always name their closed sets; `conversation_id` and
 * `correlation_id` are the ledger's nullable, best-effort provenance; `claimed_at` is when ownership was taken. The
 * engine consumes events, never a database — it names no table.
 */
export type OwnershipClaimEvent = {
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

/**
 * One RELEASE event — the durable fact that a claim's holder RELINQUISHED a coordination, in the shape the state runtime
 * selects from `receptionist_conversation_claim_releases` (R50). This is the SECOND of the engine's two inputs. Its
 * presence SUBTRACTS a coordination from current ownership — a released coordination returns to the free (`released`)
 * state even though its append-only claim event still exists. `coordination_id` is the load-bearing anchor (UNIQUE in the
 * release ledger, so a coordination has at most one release); the operator + instant are carried for a faithful event
 * shape. The engine consumes events, never a database — it names no table.
 */
export type OwnershipReleaseEvent = {
  readonly coordination_id: string;
  readonly org_id: string;
  readonly operator_id: string;
  readonly operator_email: string | null;
  readonly released_at: string;
};

/**
 * The pair of append-only events that bear on ONE coordination's ownership — its (at most one) claim event and its (at
 * most one) release event. Both are OPTIONAL: their PRESENCE (not their content) is what the derivation folds. A caller
 * that has only claim facts passes `release` absent; a never-claimed coordination passes both absent.
 */
export type OwnershipEvents = {
  readonly claim?: OwnershipClaimEvent | null;
  readonly release?: OwnershipReleaseEvent | null;
};

// ---------------------------------------------------------------------
// The OWNERSHIP STATE — the closed three-member lifecycle the engine derives.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of OWNERSHIP STATE — where a coordination sits in the claim⇄release lifecycle. R51 derives
 * exactly three, and they are TOTAL over the append-only event stream:
 *   • unclaimed — no claim event exists; no operator has taken ownership. The initial + free state.
 *   • claimed   — a claim event exists and NO release event does; an operator holds ownership now.
 *   • released  — a claim event AND a release event exist; the holder relinquished it, so it is free again.
 * There is deliberately no `reassigned`, `dispatched`, `scheduled` or `completed` member: the event stream records the
 * TAKING and the RELINQUISHING of ownership only, and everything past that is an explicit non-goal of a later,
 * separately-authorised increment. A closed const tuple, so {@link OwnershipState} is exactly these members and a
 * consumer can switch exhaustively.
 */
export const OWNERSHIP_LIFECYCLE = ["unclaimed", "claimed", "released"] as const;

/** One ownership state a coordination can be in — a member of the closed {@link OWNERSHIP_LIFECYCLE}. */
export type OwnershipState = (typeof OWNERSHIP_LIFECYCLE)[number];

// ---------------------------------------------------------------------
// The DERIVATION — the single canonical fold from a coordination's events to its ownership state.
// ---------------------------------------------------------------------

/**
 * THE canonical derivation — a coordination's append-only events → its {@link OwnershipState}. This is the ONE place
 * ownership state is derived from the event stream; every consumer reads state THROUGH the engine and re-implements this
 * fold nowhere. Pure and TOTAL over the (at most one claim, at most one release) pair:
 *   • no claim                   → `unclaimed`;
 *   • a claim, no release         → `claimed`;
 *   • a claim AND a release       → `released`.
 * The `release` is only meaningful WHEN a claim is present — a release without a claim cannot arise under R50's ownership
 * gate (the writer refuses to record one), and the engine treats it as `unclaimed` (no claim ⇒ no ownership to speak of),
 * so the fold stays total for any input. It derives state from the PRESENCE of events, not their content — it records
 * nothing, decides no claim and decides no release.
 */
export function deriveOwnershipState(events: OwnershipEvents): OwnershipState {
  if (!events.claim) return "unclaimed";
  if (events.release) return "released";
  return "claimed";
}

// ---------------------------------------------------------------------
// Total predicates + the owned/unowned projection over a derived state.
// ---------------------------------------------------------------------

/** Whether a coordination has never been claimed (its state is `unclaimed`). Total over {@link OwnershipState}. */
export function isUnclaimed(state: OwnershipState): boolean {
  return state === "unclaimed";
}

/** Whether an operator currently holds a coordination (its state is `claimed`). Total over {@link OwnershipState}. */
export function isClaimed(state: OwnershipState): boolean {
  return state === "claimed";
}

/** Whether a coordination's claim has been relinquished (its state is `released`). Total over {@link OwnershipState}. */
export function isReleased(state: OwnershipState): boolean {
  return state === "released";
}

/**
 * The canonical projection of the three-member lifecycle to the read model's owned/unowned STATUS — a coordination is
 * OWNED if and only if its state is `claimed`. `unclaimed` and `released` both project to unowned (a released item has
 * returned to the free state, carrying no CURRENT owner). This is the single definition of "owned", so the Ownership
 * Read Model's owned/unowned view derives from the engine and never re-decides it.
 */
export function isOwnedState(state: OwnershipState): boolean {
  return state === "claimed";
}

// ---------------------------------------------------------------------
// The per-coordination STATE RECORD — the derived state plus the events it was derived from.
// ---------------------------------------------------------------------

/**
 * The derived ownership state of ONE coordination — its {@link OwnershipState} plus the append-only events it was folded
 * from (so a consumer projecting a view — the current owner, the claim timestamp — reads the SAME events the engine
 * derived from, never re-fetching). The engine's authoritative per-coordination answer to "where is this in the
 * lifecycle?":
 *   • coordinationId — the coordination the state concerns.
 *   • state          — its {@link OwnershipState}: `unclaimed` / `claimed` / `released`.
 *   • claim          — the claim event it was derived from, or null (null ⟺ `unclaimed`).
 *   • release        — the release event it was derived from, or null.
 */
export type OwnershipStateRecord = {
  readonly coordinationId: string;
  readonly state: OwnershipState;
  readonly claim: OwnershipClaimEvent | null;
  readonly release: OwnershipReleaseEvent | null;
};

/**
 * Fold ONE coordination's events into its {@link OwnershipStateRecord}. Pure and total — it derives the state through the
 * single {@link deriveOwnershipState} and carries the (normalised-to-null) events alongside it. The `claim` / `release`
 * arguments are OPTIONAL and default to absent, so a never-claimed coordination folds to an `unclaimed` record with both
 * events null. It records nothing and re-decides nothing.
 */
export function projectOwnershipState(input: {
  coordinationId: string;
  claim?: OwnershipClaimEvent | null;
  release?: OwnershipReleaseEvent | null;
}): OwnershipStateRecord {
  const claim = input.claim ?? null;
  const release = input.release ?? null;
  return {
    coordinationId: input.coordinationId,
    state: deriveOwnershipState({ claim, release }),
    claim,
    release,
  };
}

/**
 * Reconcile an organisation's append-only events into per-coordination {@link OwnershipStateRecord}s — the org-wide fold
 * the state runtime performs. Given the org's claim events and its release events, it emits ONE record per CLAIMED
 * coordination (one per claim event), each folded through {@link projectOwnershipState} with its matching release (if
 * any). A coordination with no claim event is `unclaimed` and is NOT enumerated — the engine reports the coordinations
 * that HAVE entered the lifecycle, and `unclaimed` is the absence of a record. A release with no matching claim cannot
 * arise under R50's ownership gate; were one present it would simply have no claim to pair with and would be ignored.
 *
 * Pure, total and ORDER-INDEPENDENT: it consults a per-coordination map of releases, so shuffling either input never
 * changes the output (records appear in the claims' order — the runtime orders them for presentation, the engine does
 * not). Non-mutating — it returns a NEW array.
 */
export function reconcileOwnershipStates(
  claims: readonly OwnershipClaimEvent[],
  releases: readonly OwnershipReleaseEvent[],
): OwnershipStateRecord[] {
  const releaseByCoordination = new Map<string, OwnershipReleaseEvent>();
  for (const release of releases) releaseByCoordination.set(release.coordination_id, release);
  return claims.map((claim) =>
    projectOwnershipState({
      coordinationId: claim.coordination_id,
      claim,
      release: releaseByCoordination.get(claim.coordination_id) ?? null,
    }),
  );
}
