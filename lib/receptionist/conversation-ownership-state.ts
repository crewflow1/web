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
// event, so the STATE derivation is a TOTAL function of that (at most one, at most one) pair. Reassignment does NOT add a
// state: a transferred item is still `claimed`. Since R53 the engine ALSO folds the append-only REASSIGNMENT ledger (R52)
// to resolve the CURRENT OWNER — WHO holds a `claimed` coordination now — because a transfer changes the holder without
// changing the state. Ownership is thus TWO orthogonal facts the engine derives: the STATE (from claim + release) and the
// CURRENT OWNER (from claim + reassignment chain). Dispatch, scheduling and the rest remain explicit non-goals of later,
// separately-authorised increments — the engine states WHERE a coordination is and WHO holds it, and grants no affordance.
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
//   • latestReassignmentFor    — the tail of a coordination's transfer chain (by the R52 order), or null. THE order rule.
//   • resolveCurrentOwner      — a claim + its reassignment chain → the CURRENT holder, or null. THE owner resolution.
//   • projectOwnershipState    — a coordination id + its events → its {@link OwnershipStateRecord} (state, owner, events).
//   • reconcileOwnershipStates — an org's claims + releases + reassignments → one state record per claimed coordination.
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
 * One REASSIGNMENT event — the durable fact that a coordination's holder TRANSFERRED it to another named operator, in the
 * shape the state runtime selects from `receptionist_conversation_claim_reassignments` (R52). Unlike a claim or a release,
 * a coordination may have MANY reassignments (a transfer CHAIN A→B→C is a row per leg — `coordination_id` is NOT unique in
 * this ledger), so this is the engine's THIRD, MULTI-valued input. It changes WHO holds a coordination, never WHETHER it is
 * held: the derivation's three-state lifecycle is untouched (a reassigned item is still `claimed`), but the CURRENT OWNER
 * is the `to_operator` of the LATEST reassignment (by `reassigned_at`, then `created_at`, then `id` — the exact order the
 * R52 database owner-resolution uses), falling back to the original claimant when none names the coordination. The engine
 * consumes events, never a database — it names no table.
 */
export type OwnershipReassignmentEvent = {
  readonly id: string;
  readonly org_id: string;
  readonly coordination_id: string;
  readonly from_operator_id: string;
  readonly from_operator_email: string | null;
  readonly to_operator_id: string;
  readonly to_operator_email: string | null;
  readonly reassigned_at: string;
  readonly created_at: string;
};

/**
 * A resolved OWNERSHIP HOLDER — WHO holds a coordination's claim RIGHT NOW, after folding its claim and its (possibly
 * empty) reassignment chain. Just the operator's identity (id + denormalised email); the claim vocabulary + timestamps
 * live on the events. It is the engine's answer to "who is the current owner?" — the original claimant when the item was
 * never transferred, or the latest reassignment's `to_operator` when it was.
 */
export type OwnershipHolder = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
};

/**
 * The pair of append-only events that bear on ONE coordination's ownership STATE — its (at most one) claim event and its
 * (at most one) release event. Both are OPTIONAL: their PRESENCE (not their content) is what the derivation folds. A
 * caller that has only claim facts passes `release` absent; a never-claimed coordination passes both absent. Reassignment
 * events do NOT appear here — they change the current OWNER, not the STATE, so the derivation ({@link deriveOwnershipState})
 * never sees them.
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
// CURRENT-OWNER resolution — WHO holds a coordination now, folding its claim with its reassignment chain (R53).
// ---------------------------------------------------------------------

/**
 * Strictly-later ordering over two reassignment events, mirroring the R52 database owner-resolution EXACTLY:
 * `reassigned_at desc, created_at desc, id desc`. Compares INSTANTS (via `Date.parse`), never raw timestamp strings, so
 * the same moment written in different zone spellings ties and is decided by the next key; `id` (a uuid, UNIQUE) is the
 * final total tiebreak, so the "latest" is deterministic. `a` is later than `b` when its `reassigned_at` is newer, or —
 * on a tie — its `created_at` is newer, or — on a further tie — its id sorts higher.
 */
function isLaterReassignment(
  a: OwnershipReassignmentEvent,
  b: OwnershipReassignmentEvent,
): boolean {
  const ta = Date.parse(a.reassigned_at);
  const tb = Date.parse(b.reassigned_at);
  if (ta !== tb) return ta > tb;
  const ca = Date.parse(a.created_at);
  const cb = Date.parse(b.created_at);
  if (ca !== cb) return ca > cb;
  return a.id > b.id;
}

/**
 * The LATEST reassignment naming one coordination — the tail of its transfer chain — or null when none does. Pure, total
 * and ORDER-INDEPENDENT: it filters to the coordination and reduces under the total {@link isLaterReassignment} order, so
 * shuffling the input never changes the result. This is the single definition of "the reassignment that decides the
 * current owner", the read side's mirror of the R52 writer's `order by reassigned_at desc, created_at desc, id desc`.
 */
export function latestReassignmentFor(
  coordinationId: string,
  reassignments: readonly OwnershipReassignmentEvent[],
): OwnershipReassignmentEvent | null {
  let latest: OwnershipReassignmentEvent | null = null;
  for (const reassignment of reassignments) {
    if (reassignment.coordination_id !== coordinationId) continue;
    if (latest === null || isLaterReassignment(reassignment, latest)) latest = reassignment;
  }
  return latest;
}

/**
 * Resolve the CURRENT OWNER of a coordination — the single canonical fold of a claim with its reassignment chain into the
 * operator who holds it NOW. Pure and total:
 *   • no claim                         → null (no operator has ever taken it — there is nothing to hold);
 *   • a claim, no reassignment naming it → the original CLAIMANT (the item was never transferred);
 *   • a claim AND ≥1 reassignment       → the `to_operator` of the LATEST reassignment ({@link latestReassignmentFor}).
 * This is the read side's exact mirror of the R52 database owner-resolution (latest `to_operator_id`, coalesced to the
 * claimant): so the Ownership Read Model names the SAME current owner the Release + Reassignment runtimes enforce against,
 * and release authority aligns with it. It folds in no viewer and grants no affordance; it names the holder, nothing more.
 */
export function resolveCurrentOwner(
  claim: OwnershipClaimEvent | null,
  reassignments: readonly OwnershipReassignmentEvent[],
): OwnershipHolder | null {
  if (!claim) return null;
  const latest = latestReassignmentFor(claim.coordination_id, reassignments);
  if (latest) return { operatorId: latest.to_operator_id, operatorEmail: latest.to_operator_email };
  return { operatorId: claim.operator_id, operatorEmail: claim.operator_email };
}

// ---------------------------------------------------------------------
// The per-coordination STATE RECORD — the derived state plus the events it was derived from.
// ---------------------------------------------------------------------

/**
 * The derived ownership state of ONE coordination — its {@link OwnershipState} plus the append-only events it was folded
 * from (so a consumer projecting a view — the current owner, the claim timestamp — reads the SAME events the engine
 * derived from, never re-fetching). The engine's authoritative per-coordination answer to "where is this in the
 * lifecycle?" AND "who holds it now?":
 *   • coordinationId — the coordination the state concerns.
 *   • state          — its {@link OwnershipState}: `unclaimed` / `claimed` / `released`. Folded from claim + release ONLY.
 *   • claim          — the claim event it was derived from, or null (null ⟺ `unclaimed`).
 *   • release        — the release event it was derived from, or null.
 *   • reassignments  — this coordination's transfer chain (R52), in the order read; empty when it was never transferred.
 *   • currentOwner   — WHO holds it now ({@link resolveCurrentOwner}): the latest reassignment's `to_operator`, else the
 *                      claimant, or null when `unclaimed`. Meaningful when `state === 'claimed'`; on a `released` record it
 *                      names the last holder before release, which the read model projects as unowned (state, not owner,
 *                      decides owned/unowned).
 */
export type OwnershipStateRecord = {
  readonly coordinationId: string;
  readonly state: OwnershipState;
  readonly claim: OwnershipClaimEvent | null;
  readonly release: OwnershipReleaseEvent | null;
  readonly reassignments: readonly OwnershipReassignmentEvent[];
  readonly currentOwner: OwnershipHolder | null;
};

/**
 * Fold ONE coordination's events into its {@link OwnershipStateRecord}. Pure and total — it derives the STATE through the
 * single {@link deriveOwnershipState} (claim + release only), resolves the CURRENT OWNER through the single
 * {@link resolveCurrentOwner} (claim + reassignments), and carries the (normalised-to-null) events alongside. The `claim`
 * / `release` / `reassignments` arguments are OPTIONAL and default to absent/empty, so a never-claimed coordination folds
 * to an `unclaimed` record with no events and no owner. The `reassignments` are filtered to THIS coordination defensively,
 * so the record only ever carries its own transfer chain. It records nothing and re-decides nothing.
 */
export function projectOwnershipState(input: {
  coordinationId: string;
  claim?: OwnershipClaimEvent | null;
  release?: OwnershipReleaseEvent | null;
  reassignments?: readonly OwnershipReassignmentEvent[];
}): OwnershipStateRecord {
  const claim = input.claim ?? null;
  const release = input.release ?? null;
  const reassignments = (input.reassignments ?? []).filter(
    (reassignment) => reassignment.coordination_id === input.coordinationId,
  );
  return {
    coordinationId: input.coordinationId,
    state: deriveOwnershipState({ claim, release }),
    claim,
    release,
    reassignments,
    currentOwner: resolveCurrentOwner(claim, reassignments),
  };
}

/**
 * Reconcile an organisation's append-only events into per-coordination {@link OwnershipStateRecord}s — the org-wide fold
 * the state runtime performs. Given the org's claim events, its release events and its reassignment events, it emits ONE
 * record per CLAIMED coordination (one per claim event), each folded through {@link projectOwnershipState} with its
 * matching release (if any, at most one) and its matching reassignment CHAIN (if any, possibly many). A coordination with
 * no claim event is `unclaimed` and is NOT enumerated — the engine reports the coordinations that HAVE entered the
 * lifecycle, and `unclaimed` is the absence of a record. A release or reassignment with no matching claim cannot arise
 * under the R50/R52 ownership gates; were one present it would simply have no claim to pair with and would be ignored.
 *
 * Pure, total and ORDER-INDEPENDENT: it consults a per-coordination map of releases and a per-coordination map of
 * reassignment chains, so shuffling any input never changes the output (records appear in the claims' order — the runtime
 * orders them for presentation, the engine does not; the current-owner fold re-sorts each chain internally). Non-mutating
 * — it returns a NEW array. The `reassignments` argument is OPTIONAL and defaults to empty (a claim-and-release-only fold).
 */
export function reconcileOwnershipStates(
  claims: readonly OwnershipClaimEvent[],
  releases: readonly OwnershipReleaseEvent[],
  reassignments: readonly OwnershipReassignmentEvent[] = [],
): OwnershipStateRecord[] {
  const releaseByCoordination = new Map<string, OwnershipReleaseEvent>();
  for (const release of releases) releaseByCoordination.set(release.coordination_id, release);
  const reassignmentsByCoordination = new Map<string, OwnershipReassignmentEvent[]>();
  for (const reassignment of reassignments) {
    const chain = reassignmentsByCoordination.get(reassignment.coordination_id);
    if (chain) chain.push(reassignment);
    else reassignmentsByCoordination.set(reassignment.coordination_id, [reassignment]);
  }
  return claims.map((claim) =>
    projectOwnershipState({
      coordinationId: claim.coordination_id,
      claim,
      release: releaseByCoordination.get(claim.coordination_id) ?? null,
      reassignments: reassignmentsByCoordination.get(claim.coordination_id) ?? [],
    }),
  );
}
