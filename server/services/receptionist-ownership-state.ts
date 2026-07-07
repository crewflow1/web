import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  projectOwnershipState,
  reconcileOwnershipStates,
  type OwnershipClaimEvent,
  type OwnershipReleaseEvent,
  type OwnershipStateRecord,
} from "@/lib/receptionist/conversation-ownership-state";

// =====================================================================
// THE CONVERSATION OWNERSHIP STATE ENGINE — SERVER RUNTIME (CEO Directive #018, R51: CONVERSATION OWNERSHIP STATE
// ENGINE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item into the append-only, service-role-only
// `receptionist_conversation_claims` ledger (one row per coordination, `coordination_id` UNIQUE); R50 records that
// operator's RELEASE into the append-only, service-role-only `receptionist_conversation_claim_releases` ledger (one row
// per coordination, `coordination_id` UNIQUE). Those two ledgers are the APPEND-ONLY OWNERSHIP EVENT STREAM. R51 makes
// THIS runtime the SINGLE authoritative source of ownership STATE over that stream: it is the ONE module that reads the
// event stream for ownership, folds it through the pure engine core ({@link deriveOwnershipState} via
// {@link projectOwnershipState} / {@link reconcileOwnershipStates}), and answers "where is this coordination in the
// claim⇄release lifecycle?". No consumer reads the ledgers for ownership or rolls its own derivation — the Ownership Read
// Model (R48) and everything above it read ownership state THROUGH the seams here.
//
// IT IS READ-ONLY, AND A DERIVATION — NOT BEHAVIOUR. It records nothing, decides no claim and decides no release, and
// names NO write primitive of ANY engine (not `record_receptionist_conversation_claim`, not
// `record_receptionist_conversation_claim_release`, not any coordination / lifecycle / fulfilment writer): there is
// provably no execution path here. The R46 runtime (`claimConversationWork`) remains the SOLE authority over recording a
// claim, and the R50 runtime (`releaseConversationWork`) the SOLE authority over recording a release — this runtime
// re-derives NOTHING it writes; it SELECTs the event stream and folds it. It never claims, releases, reassigns,
// dispatches, notifies, schedules or completes anything — it only DERIVES state.
//
// IT CONSUMES ONLY THE TWO APPEND-ONLY LEDGERS — THE CLAIMS LEDGER AND ITS RELEASES LEDGER. Every read is a SELECT
// against `receptionist_conversation_claims` or `receptionist_conversation_claim_releases` and no other table: the state
// engine reads no coordination table, no sibling engine and no view. Because both ledgers are append-only and
// `coordination_id` is UNIQUE in each, a coordination has AT MOST ONE claim event and AT MOST ONE release event, so its
// state is the pure fold of that (at most one, at most one) pair — `unclaimed` (no claim), `claimed` (a claim, no
// release) or `released` (a claim and a release) — computed in exactly ONE place, the engine core.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` filter is MANDATORY on every query — every claims read AND every
// releases read — so one organisation can never read another's ownership state: organisation isolation is structural
// here, exactly as it is on the R37 coordination reader, the R47 claim reader and the (now delegating) R48 read model.
//
// Both ledgers are service-role-only internals (RLS-enabled, zero policies; not in the generated Database types), so
// each query casts past the typed client with the same `as never` / `as unknown as` convention the R47 claim reader and
// the R37 read model use.
// =====================================================================

/** Every column the state engine reads from the `receptionist_conversation_claims` ledger, in a stable order. */
const CLAIM_COLUMNS =
  "coordination_id, org_id, conversation_id, correlation_id, operator_id, operator_email, " +
  "claim_type, claim_outcome, status, claimed_at";

/**
 * Every column the state engine reads from the `receptionist_conversation_claim_releases` ledger, in a stable order.
 * Only the coordination + org are load-bearing for the derivation (a release SUBTRACTS its coordination from current
 * ownership); the operator + instant are carried for a faithful event shape.
 */
const RELEASE_COLUMNS = "coordination_id, org_id, operator_id, operator_email, released_at";

// The ledgers are not in the generated Database types — cast past the typed client to the minimal chainable surface
// these reads use (the same convention the R47 claim reader / R37 read model use). The builder is a thenable, so the
// interface extends PromiseLike and `await` yields the { data, error } envelope.
type ReadResult<Row> = { data: Row[] | null; error: { message: string } | null };
interface ReadQuery<Row> extends PromiseLike<ReadResult<Row>> {
  select(columns: string): ReadQuery<Row>;
  eq(column: string, value: string): ReadQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): ReadQuery<Row>;
  limit(count: number): ReadQuery<Row>;
}

function claimsLedger(): ReadQuery<OwnershipClaimEvent> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claims" as never,
  ) as unknown as ReadQuery<OwnershipClaimEvent>;
}

function releasesLedger(): ReadQuery<OwnershipReleaseEvent> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claim_releases" as never,
  ) as unknown as ReadQuery<OwnershipReleaseEvent>;
}

/**
 * The derived ownership STATE of ONE coordination in an organisation — its position in the claim⇄release lifecycle
 * (`unclaimed` / `claimed` / `released`), carrying the events it was derived from. THE per-item state lookup the read
 * model consumes. Org-scoped: the `org_id` filter is MANDATORY on BOTH reads, so one org can never read another's state.
 * Single-valued: `coordination_id` is UNIQUE in each ledger, so this resolves AT MOST ONE claim event and AT MOST ONE
 * release event, folded through the pure {@link projectOwnershipState}.
 *
 * READ-ONLY: it SELECTs the recorded claim and the recorded release (or reads their absence) and folds them; it records
 * nothing, decides no claim and decides no release. The R46 runtime remains authoritative over recording a claim and the
 * R50 runtime over recording a release; this only derives state from what they recorded.
 */
export async function getCoordinationOwnershipState(input: {
  org_id: string;
  coordination_id: string;
}): Promise<OwnershipStateRecord> {
  const { data, error } = await claimsLedger()
    .select(CLAIM_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("coordination_id", input.coordination_id)
    .limit(1);
  if (error) {
    throw new Error("receptionist_conversation_claims read failed: " + error.message);
  }
  const { data: releaseData, error: releaseError } = await releasesLedger()
    .select(RELEASE_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("coordination_id", input.coordination_id)
    .limit(1);
  if (releaseError) {
    throw new Error(
      "receptionist_conversation_claim_releases read failed: " + releaseError.message,
    );
  }
  return projectOwnershipState({
    coordinationId: input.coordination_id,
    claim: data?.[0] ?? null,
    release: releaseData?.[0] ?? null,
  });
}

/**
 * The derived ownership STATE of every coordination that has entered the lifecycle in an organisation — one
 * {@link OwnershipStateRecord} per recorded claim (`claimed` or `released`, depending on whether a release event names
 * it), reconciled through the pure {@link reconcileOwnershipStates}. THE org-wide state read the read model's history +
 * summary consume. Org-scoped: the `org_id` filter is MANDATORY on BOTH reads, so one org can never read another's
 * state. The claim events are read newest-first (stable tiebreak on coordination id) so a `limit`, when supplied, keeps
 * the most recent — and the releases are read UNCAPPED, so every claim is reconciled against every release. When no
 * `limit` is supplied the claims are uncapped too (the summary must see them all).
 *
 * READ-ONLY: it SELECTs the recorded claims and releases and folds them; it records nothing and derives no claim or
 * release.
 */
export async function listCoordinationOwnershipStates(input: {
  org_id: string;
  limit?: number;
}): Promise<OwnershipStateRecord[]> {
  let claimsQuery = claimsLedger()
    .select(CLAIM_COLUMNS)
    .eq("org_id", input.org_id)
    .order("claimed_at", { ascending: false })
    .order("coordination_id", { ascending: false });
  if (input.limit !== undefined) claimsQuery = claimsQuery.limit(input.limit);
  const { data, error } = await claimsQuery;
  if (error) {
    throw new Error("receptionist_conversation_claims read failed: " + error.message);
  }
  const { data: releaseData, error: releaseError } = await releasesLedger()
    .select(RELEASE_COLUMNS)
    .eq("org_id", input.org_id);
  if (releaseError) {
    throw new Error(
      "receptionist_conversation_claim_releases read failed: " + releaseError.message,
    );
  }
  return reconcileOwnershipStates(data ?? [], releaseData ?? []);
}
