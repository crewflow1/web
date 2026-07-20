import "server-only";
import {
  getCoordinationOwnershipState,
  listCoordinationOwnershipStates,
} from "@/server/services/receptionist-ownership-state";
import {
  projectOwnership,
  projectOwnershipEvent,
  orderOwnershipEvents,
  summariseOwnership,
  selectActiveClaims,
  type OwnershipClaimRow,
  type OwnershipReleaseRow,
  type OwnershipReassignmentRow,
  type OwnershipRecord,
  type OwnershipEvent,
  type OwnershipSummary,
} from "@/lib/receptionist/conversation-ownership-read-model";
import type { OwnershipStateRecord } from "@/lib/receptionist/conversation-ownership-state";

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — SERVER READER (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL; consuming the Ownership State Engine since R51: CONVERSATION OWNERSHIP STATE ENGINE; reassignment-aware since
// R53: OWNERSHIP READ MODEL REASSIGNMENT AWARENESS).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item; R50 records its RELEASE; R52 records a
// REASSIGNMENT (a holder TRANSFERS it to another operator); all land in append-only, service-role-only ledgers that
// together form the OWNERSHIP EVENT STREAM. R48 is the CANONICAL OWNERSHIP READ MODEL — the SINGLE authoritative read
// layer for ownership FACTS (who owns this NOW? what is the history? what does ownership look like across the org?). R51
// established the OWNERSHIP STATE ENGINE beneath it and R53 taught that engine to fold the reassignment chain into the
// CURRENT OWNER; this reader is a pure CONSUMER of that engine: it reads ownership state THROUGH the state runtime
// (`getCoordinationOwnershipState` / `listCoordinationOwnershipStates`) — which now carries each coordination's transfer
// chain and current owner — and PROJECTS it into the read model's views. It no longer reads the ledgers itself — the
// state engine is the only authorised source of ownership state.
//
// IT CONSUMES ONLY THE OWNERSHIP STATE ENGINE — NO LEDGER, NO `.from(...)`. Every read here is a call into the R51 state
// runtime, which is the SOLE reader of the append-only claim + release + reassignment ledgers for ownership. The reader
// names no table, opens no admin client and issues no query: it asks the engine for the derived state (with its claim,
// release and reassignment events) and folds that state into an {@link OwnershipRecord} / {@link OwnershipEvent} list /
// {@link OwnershipSummary} through the pure read-model core ({@link projectOwnership} / {@link projectOwnershipEvent} /
// {@link summariseOwnership} / {@link selectActiveClaims} / {@link orderOwnershipEvents}). It recovers the events the
// engine derived from — the claims, releases AND reassignments — via {@link claimsOf} / {@link releasesOf} /
// {@link reassignmentsOf}. Ownership DERIVATION (state AND current owner) is the engine's; PRESENTATION (owned/unowned,
// current holder vs original claimant, history order, summary) is the read model's — and this reader is where they meet.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim, no release and no reassignment,
// and names NO write primitive of ANY engine: there is provably no execution path here. The R46 runtime
// (`claimConversationWork`) remains the SOLE authority over recording a claim, the R50 runtime
// (`releaseConversationWork`) over recording a release, the R52 runtime (`reassignConversationWork`) over recording a
// transfer, and the R51 state engine the SOLE authority over deriving ownership state — this reader re-derives NOTHING; it
// consumes the engine and projects. It never claims, releases, reassigns, dispatches or notifies.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` is MANDATORY on every state-engine call, and the state runtime applies
// it as a filter on every ledger read — so one organisation can never read another's ownership. Organisation isolation
// is enforced in the engine (proven over Postgres in its own pipeline + invariant suites) and threaded through here.
// =====================================================================

/**
 * The claim events carried by a set of state records — one per record, since every coordination the engine ENUMERATES
 * has a recorded claim event (an `unclaimed` coordination has no record). This is the read model's claim-event input,
 * recovered from the engine's derived state rather than re-read from the ledger.
 */
function claimsOf(records: readonly OwnershipStateRecord[]): OwnershipClaimRow[] {
  return records.flatMap((record) => (record.claim ? [record.claim] : []));
}

/**
 * The release events carried by a set of state records — one per record whose coordination the engine derived as
 * `released` (it carries the release event that subtracted it). The read model's release-event input, recovered from the
 * engine's derived state.
 */
function releasesOf(records: readonly OwnershipStateRecord[]): OwnershipReleaseRow[] {
  return records.flatMap((record) => (record.release ? [record.release] : []));
}

/**
 * The reassignment events carried by a set of state records — the org's full transfer stream, recovered from the engine's
 * derived state (each record carries its coordination's chain, already filtered to itself by the engine). Flattened back
 * into one list so the read-model core can re-attribute each claim to its CURRENT owner. A never-transferred coordination
 * contributes none; a chain A→B→C contributes a row per leg.
 */
function reassignmentsOf(records: readonly OwnershipStateRecord[]): OwnershipReassignmentRow[] {
  return records.flatMap((record) => [...record.reassignments]);
}

/**
 * The ownership of ONE coordination in an organisation — the CURRENT owner (operator B after an A→B transfer), the
 * original claimant, the claim timestamp and the ownership status (`owned` / `unowned`). THE per-item ownership lookup:
 * who owns this coordination's work item NOW. It asks the R51 state engine for the coordination's derived state
 * (`getCoordinationOwnershipState`, org-scoped) — which carries the claim, the release and the reassignment chain — and
 * PROJECTS that state's events through the pure {@link projectOwnership}: `owned` and attributed to the current holder
 * when the engine derived `claimed`, `unowned` when it derived `unclaimed` or `released`.
 *
 * READ-ONLY: it consumes the engine and projects; it records nothing, decides no claim, no release and no reassignment.
 * The R46 runtime remains authoritative over recording a claim, the R50 runtime over a release, the R52 runtime over a
 * transfer, and the R51 engine over deriving state; this only reads back the ownership fact.
 */
export async function getOwnership(input: {
  org_id: string;
  coordination_id: string;
}): Promise<OwnershipRecord> {
  const record = await getCoordinationOwnershipState({
    org_id: input.org_id,
    coordination_id: input.coordination_id,
  });
  return projectOwnership({
    coordinationId: record.coordinationId,
    claim: record.claim,
    release: record.release,
    reassignments: record.reassignments,
  });
}

/**
 * The organisation's ownership HISTORY — every CURRENT ownership event (one per coordination the engine derives as still
 * `claimed`), newest first. THE ownership audit trail: who holds ownership of what, since when, and who first claimed it.
 * It asks the R51 state engine for the org's derived states (`listCoordinationOwnershipStates`, org-scoped, capped by
 * `limit`, default 100), keeps the still-`claimed` coordinations via the pure {@link selectActiveClaims} (a released
 * coordination is SUBTRACTED), recovers the org's transfer stream via {@link reassignmentsOf}, and projects each survivor
 * through {@link projectOwnershipEvent} — attributing the CURRENT holder while preserving the original claimant — before
 * ordering them canonically by {@link orderOwnershipEvents} (newest claim first, stable tiebreak on coordination id).
 *
 * READ-ONLY: it consumes the engine's state and projects each survivor; it records nothing and derives no claim, release
 * or reassignment.
 */
export async function getOwnershipHistory(input: {
  org_id: string;
  limit?: number;
}): Promise<OwnershipEvent[]> {
  const records = await listCoordinationOwnershipStates({
    org_id: input.org_id,
    limit: input.limit ?? 100,
  });
  const active = selectActiveClaims(claimsOf(records), releasesOf(records));
  const reassignments = reassignmentsOf(records);
  return orderOwnershipEvents(active.map((claim) => projectOwnershipEvent(claim, reassignments)));
}

/**
 * The organisation's ownership SUMMARY — aggregates over every CURRENTLY-OWNED coordination in the org (one the engine
 * derives as still `claimed`), grouped by CURRENT owner: total claims, distinct owners, the per-owner tallies, and the
 * latest / earliest claim instants. THE ownership overview a future dashboard reads. It asks the R51 state engine for the
 * org's derived states (`listCoordinationOwnershipStates`, org-scoped, UNCAPPED — an accurate aggregate must see every
 * coordination), keeps the still-`claimed` ones via the pure {@link selectActiveClaims}, recovers the org's transfer
 * stream via {@link reassignmentsOf}, and folds them through the order-independent {@link summariseOwnership} — which
 * attributes each held coordination to the operator who holds it NOW.
 *
 * READ-ONLY: it consumes the engine's state and folds the survivors; it records nothing and derives no claim, release or
 * reassignment.
 */
export async function getOwnershipSummary(input: { org_id: string }): Promise<OwnershipSummary> {
  const records = await listCoordinationOwnershipStates({ org_id: input.org_id });
  return summariseOwnership(
    selectActiveClaims(claimsOf(records), releasesOf(records)),
    reassignmentsOf(records),
  );
}
