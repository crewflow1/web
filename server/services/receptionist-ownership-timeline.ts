import "server-only";
import { getCoordinationOwnershipState } from "@/server/services/receptionist-ownership-state";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import {
  projectOwnershipTimeline,
  type OwnershipTimelineView,
} from "@/lib/receptionist/conversation-ownership-timeline";

// =====================================================================
// THE CONVERSATION OWNERSHIP TIMELINE — SERVER RUNTIME (CEO Directive #018, R55: CONVERSATION OWNERSHIP TIMELINE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item; R50 records its RELEASE; R52 records a
// REASSIGNMENT (a holder TRANSFERS it to another operator) — all into append-only, service-role-only ledgers that together
// form the OWNERSHIP EVENT STREAM. R51 made the Ownership STATE ENGINE the SOLE reader of that stream; R48/R53 made the
// Ownership READ MODEL the authoritative VIEW of the PRESENT owner over the engine. R55 adds the canonical HISTORICAL
// projection: the OWNERSHIP TIMELINE — a coordination's append-only ownership history, presented chronologically.
//
// IT CONSUMES ONLY THE AUTHORISED OWNERSHIP SEAMS — IT READS NO LEDGER AND DERIVES NO OWNERSHIP. This runtime opens no
// database client, names no ledger table and issues no query: it composes exactly two authorised reads and folds them
// through the pure core:
//   • the R51 STATE ENGINE ({@link getCoordinationOwnershipState}) — for the coordination's RAW append-only events (its
//     claim, its release and its reassignment chain), recovered by the ONE module authorised to read the three ledgers. The
//     timeline consumes the claim / release / reassignment ledgers TRANSITIVELY, through the engine — never directly;
//   • the R48/R53 READ MODEL ({@link getOwnership}) — for the PRESENT-ownership HEADER (owned/unowned, the current owner,
//     whether by transfer, since when), already derived by the authoritative read model.
// {@link projectOwnershipTimeline} then relabels the raw events into chronological ownership TRANSITIONS and copies the
// record into the header. Ownership DERIVATION stays the engine's and the read model's; this runtime re-derives nothing.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim, no release and no reassignment,
// and names NO write primitive of ANY engine: there is provably no execution path here. The R46 runtime remains the SOLE
// authority over recording a claim, the R50 runtime over a release, the R52 runtime over a transfer, the R51 engine over
// deriving state and the R48 read model over the present owner — this runtime consumes them and projects the history. It
// never claims, releases, reassigns, dispatches, notifies, schedules or completes anything.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` is MANDATORY on BOTH seam calls, and each seam applies it as a filter on
// every underlying read — so one organisation can never read another's ownership history. Organisation isolation is enforced
// beneath (proven over Postgres in the engine's + read model's own suites) and threaded through here unchanged.
// =====================================================================

/**
 * The ownership TIMELINE of ONE coordination in an organisation — its append-only ownership history (claim → transfers →
 * release, oldest first) plus the PRESENT-ownership header. THE per-item historical lookup: how did ownership of this
 * coordination's work item move, and who holds it now? It reads the coordination's derived state from the R51 engine
 * (`getCoordinationOwnershipState`, org-scoped) — for the RAW claim, release and reassignment events — and its present
 * ownership from the R48/R53 read model (`getOwnership`, org-scoped) — for the HEADER — then folds both through the pure
 * {@link projectOwnershipTimeline}: the events become chronological ownership transitions, the record becomes the header.
 *
 * READ-ONLY: it consumes the two authorised seams and projects; it records nothing, decides no claim, no release and no
 * reassignment, and re-derives no ownership (the engine derives state, the read model derives the present owner). Both
 * reads are org-scoped, so the timeline can never cross a tenant boundary.
 */
export async function getOwnershipTimeline(input: {
  org_id: string;
  coordination_id: string;
}): Promise<OwnershipTimelineView> {
  // The RAW append-only events — the R51 state engine, the sole authorised reader of the claim / release / reassignment
  // ledgers. Org-scoped: the `org_id` filter is threaded into the engine, which applies it to every ledger read.
  const state = await getCoordinationOwnershipState({
    org_id: input.org_id,
    coordination_id: input.coordination_id,
  });
  // The PRESENT-ownership HEADER — the R48/R53 read model's authoritative current-owner projection. Org-scoped likewise.
  const ownership = await getOwnership({
    org_id: input.org_id,
    coordination_id: input.coordination_id,
  });
  return projectOwnershipTimeline({
    coordinationId: state.coordinationId,
    ownership,
    claim: state.claim,
    release: state.release,
    reassignments: state.reassignments,
  });
}
