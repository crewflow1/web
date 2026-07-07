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
  type OwnershipRecord,
  type OwnershipEvent,
  type OwnershipSummary,
} from "@/lib/receptionist/conversation-ownership-read-model";
import type { OwnershipStateRecord } from "@/lib/receptionist/conversation-ownership-state";

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — SERVER READER (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL; consuming the Ownership State Engine since R51: CONVERSATION OWNERSHIP STATE ENGINE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item; R50 records its RELEASE; both land in
// append-only, service-role-only ledgers that together form the OWNERSHIP EVENT STREAM. R48 is the CANONICAL OWNERSHIP
// READ MODEL — the SINGLE authoritative read layer for ownership FACTS (who owns this? what is the history? what does
// ownership look like across the org?). R51 established the OWNERSHIP STATE ENGINE beneath it, and this reader is now a
// pure CONSUMER of that engine: it reads ownership state THROUGH the state runtime
// (`getCoordinationOwnershipState` / `listCoordinationOwnershipStates`) and PROJECTS it into the read model's views. It
// no longer reads the ledgers itself — the state engine is the only authorised source of ownership state.
//
// IT CONSUMES ONLY THE OWNERSHIP STATE ENGINE — NO LEDGER, NO `.from(...)`. Every read here is a call into the R51 state
// runtime, which is the SOLE reader of the append-only claim + release ledgers for ownership. The reader names no table,
// opens no admin client and issues no query: it asks the engine for the derived state and folds that state into an
// {@link OwnershipRecord} / {@link OwnershipEvent} list / {@link OwnershipSummary} through the pure read-model core
// ({@link projectOwnership} / {@link projectOwnershipEvent} / {@link summariseOwnership} / {@link selectActiveClaims} /
// {@link orderOwnershipEvents}). Ownership DERIVATION is the engine's; PRESENTATION (owned/unowned, history order,
// summary) is the read model's — and this reader is where they meet.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim and decides no release, and
// names NO write primitive of ANY engine: there is provably no execution path here. The R46 runtime
// (`claimConversationWork`) remains the SOLE authority over recording a claim, the R50 runtime
// (`releaseConversationWork`) over recording a release, and the R51 state engine the SOLE authority over deriving
// ownership state — this reader re-derives NOTHING; it consumes the engine and projects. It never claims, releases,
// reassigns, dispatches or notifies.
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
 * The ownership of ONE coordination in an organisation — the current owner, the claim timestamp and the ownership
 * status (`owned` / `unowned`). THE per-item ownership lookup: who owns this coordination's work item. It asks the R51
 * state engine for the coordination's derived state (`getCoordinationOwnershipState`, org-scoped) and PROJECTS that
 * state's events through the pure {@link projectOwnership} — `owned` when the engine derived `claimed`, `unowned` when it
 * derived `unclaimed` or `released`.
 *
 * READ-ONLY: it consumes the engine and projects; it records nothing, decides no claim and decides no release. The R46
 * runtime remains authoritative over recording a claim, the R50 runtime over a release, and the R51 engine over deriving
 * state; this only reads back the ownership fact.
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
  });
}

/**
 * The organisation's ownership HISTORY — every CURRENT ownership event (one per coordination the engine derives as still
 * `claimed`), newest first. THE ownership audit trail: who holds ownership of what, and since when. It asks the R51 state
 * engine for the org's derived states (`listCoordinationOwnershipStates`, org-scoped, capped by `limit`, default 100),
 * keeps the still-`claimed` coordinations via the pure {@link selectActiveClaims} (a released coordination is SUBTRACTED),
 * and orders the survivors canonically by {@link orderOwnershipEvents} (newest claim first, stable tiebreak on
 * coordination id).
 *
 * READ-ONLY: it consumes the engine's state and projects each survivor through the pure {@link projectOwnershipEvent}; it
 * records nothing and derives no claim or release.
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
  return orderOwnershipEvents(active.map(projectOwnershipEvent));
}

/**
 * The organisation's ownership SUMMARY — aggregates over every CURRENTLY-OWNED coordination in the org (one the engine
 * derives as still `claimed`): total claims, distinct owners, the per-owner tallies, and the latest / earliest claim
 * instants. THE ownership overview a future dashboard reads. It asks the R51 state engine for the org's derived states
 * (`listCoordinationOwnershipStates`, org-scoped, UNCAPPED — an accurate aggregate must see every coordination), keeps
 * the still-`claimed` ones via the pure {@link selectActiveClaims}, and folds them through the order-independent
 * {@link summariseOwnership}.
 *
 * READ-ONLY: it consumes the engine's state and folds the survivors; it records nothing and derives no claim or release.
 */
export async function getOwnershipSummary(input: { org_id: string }): Promise<OwnershipSummary> {
  const records = await listCoordinationOwnershipStates({ org_id: input.org_id });
  return summariseOwnership(selectActiveClaims(claimsOf(records), releasesOf(records)));
}
