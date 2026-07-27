import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  projectOwnershipState,
  reconcileOwnershipStates,
  type OwnershipClaimEvent,
  type OwnershipReleaseEvent,
  type OwnershipReassignmentEvent,
  type OwnershipStateRecord,
} from "@/lib/receptionist/conversation-ownership-state";

// =====================================================================
// THE CONVERSATION OWNERSHIP STATE ENGINE — SERVER RUNTIME (CEO Directive #018, R51: CONVERSATION OWNERSHIP STATE
// ENGINE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item into the append-only, service-role-only
// `receptionist_conversation_claims` ledger (one row per coordination, `coordination_id` UNIQUE); R50 records that
// operator's RELEASE into the append-only, service-role-only `receptionist_conversation_claim_releases` ledger (one row
// per coordination, `coordination_id` UNIQUE); R52 records a TRANSFER into the append-only, service-role-only
// `receptionist_conversation_claim_reassignments` ledger (a row per transfer LEG — `coordination_id` is NOT unique, a
// chain A→B→C is many rows). Those three ledgers are the APPEND-ONLY OWNERSHIP EVENT STREAM. R51 makes THIS runtime the
// SINGLE authoritative source of ownership over that stream, and R53 extends it to fold reassignments: it is the ONE
// module that reads the event stream for ownership, folds it through the pure engine core (STATE via
// {@link deriveOwnershipState}, CURRENT OWNER via {@link resolveCurrentOwner}, both through {@link projectOwnershipState}
// / {@link reconcileOwnershipStates}), and answers "where is this coordination in the claim⇄release lifecycle, and WHO
// holds it now?". No consumer reads the ledgers for ownership or rolls its own derivation — the Ownership Read Model (R48)
// and everything above it read ownership state THROUGH the seams here.
//
// IT IS READ-ONLY, AND A DERIVATION — NOT BEHAVIOUR. It records nothing, decides no claim, no release and no
// reassignment, and names NO write primitive of ANY engine (not `record_receptionist_conversation_claim`, not
// `record_receptionist_conversation_claim_release`, not `record_receptionist_conversation_claim_reassignment`, not any
// coordination / lifecycle / fulfilment writer): there is provably no execution path here. The R46 runtime
// (`claimConversationWork`) remains the SOLE authority over recording a claim, the R50 runtime
// (`releaseConversationWork`) over a release, and the R52 runtime (`reassignConversationWork`) over a transfer — this
// runtime re-derives NOTHING it writes; it SELECTs the event stream and folds it. It never claims, releases, reassigns,
// dispatches, notifies, schedules or completes anything — it only DERIVES ownership.
//
// IT CONSUMES ONLY THE THREE APPEND-ONLY LEDGERS — THE CLAIMS LEDGER, ITS RELEASES LEDGER AND ITS REASSIGNMENTS LEDGER.
// Every read is a SELECT against `receptionist_conversation_claims`, `receptionist_conversation_claim_releases` or
// `receptionist_conversation_claim_reassignments` and no other table: the state engine reads no coordination table, no
// sibling engine and no view. Because the claim + release ledgers are append-only and `coordination_id` is UNIQUE in
// each, a coordination has AT MOST ONE claim event and AT MOST ONE release event, so its STATE is the pure fold of that
// (at most one, at most one) pair — `unclaimed` / `claimed` / `released` — computed in exactly ONE place, the engine core.
// Its CURRENT OWNER folds in the reassignment chain (many rows per coordination): the latest transfer's `to_operator`,
// else the claimant — resolved in that same one place.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` filter is MANDATORY on every query — every claims read, every releases
// read AND every reassignments read — so one organisation can never read another's ownership: organisation isolation is
// structural here, exactly as it is on the R37 coordination reader, the R47 claim reader and the (now delegating) R48
// read model.
//
// All three ledgers are service-role-only internals (RLS-enabled, zero policies; not in the generated Database types), so
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

/**
 * Every column the state engine reads from the `receptionist_conversation_claim_reassignments` ledger (R52), in a stable
 * order. The `to_operator` is the load-bearing identity (it names the holder a transfer moves ownership to); the
 * `from_operator` is carried for a faithful event shape; `reassigned_at` / `created_at` / `id` are the exact keys the
 * current-owner fold orders by (`reassigned_at desc, created_at desc, id desc`) to pick the tail of the transfer chain.
 */
const REASSIGNMENT_COLUMNS =
  "id, org_id, coordination_id, from_operator_id, from_operator_email, " +
  "to_operator_id, to_operator_email, reassigned_at, created_at";

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

function reassignmentsLedger(): ReadQuery<OwnershipReassignmentEvent> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claim_reassignments" as never,
  ) as unknown as ReadQuery<OwnershipReassignmentEvent>;
}

/**
 * The derived ownership STATE of ONE coordination in an organisation — its position in the claim⇄release lifecycle
 * (`unclaimed` / `claimed` / `released`) AND its current owner, carrying the events it was derived from. THE per-item
 * state lookup the read model consumes. Org-scoped: the `org_id` filter is MANDATORY on all THREE reads, so one org can
 * never read another's state. Single-valued for state (`coordination_id` is UNIQUE in the claim + release ledgers, so
 * this resolves AT MOST ONE of each), multi-valued for the transfer chain (the reassignment ledger has a row per leg);
 * all folded through the pure {@link projectOwnershipState}.
 *
 * READ-ONLY: it SELECTs the recorded claim, release and reassignment chain (or reads their absence) and folds them; it
 * records nothing, decides no claim, no release and no reassignment. The R46 runtime remains authoritative over recording
 * a claim, the R50 runtime over a release and the R52 runtime over a transfer; this only derives ownership from what they
 * recorded.
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
  // The transfer CHAIN (R52) — every reassignment naming this coordination, org-scoped, UNCAPPED (a chain has many rows
  // and the current-owner fold must see them all to pick the latest). `coordination_id` is NOT unique in this ledger.
  const { data: reassignmentData, error: reassignmentError } = await reassignmentsLedger()
    .select(REASSIGNMENT_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("coordination_id", input.coordination_id);
  if (reassignmentError) {
    throw new Error(
      "receptionist_conversation_claim_reassignments read failed: " + reassignmentError.message,
    );
  }
  return projectOwnershipState({
    coordinationId: input.coordination_id,
    claim: data?.[0] ?? null,
    release: releaseData?.[0] ?? null,
    reassignments: reassignmentData ?? [],
  });
}

/**
 * The derived ownership STATE of every coordination that has entered the lifecycle in an organisation — one
 * {@link OwnershipStateRecord} per recorded claim (`claimed` or `released`, depending on whether a release event names
 * it), reconciled through the pure {@link reconcileOwnershipStates}. THE org-wide state read the read model's history +
 * summary consume. Org-scoped: the `org_id` filter is MANDATORY on all THREE reads, so one org can never read another's
 * state. The claim events are read newest-first (stable tiebreak on coordination id) so a `limit`, when supplied, keeps
 * the most recent — and the releases AND reassignments are read UNCAPPED, so every claim is reconciled against every
 * release and every transfer that names it. When no `limit` is supplied the claims are uncapped too (the summary must see
 * them all).
 *
 * READ-ONLY: it SELECTs the recorded claims, releases and reassignments and folds them; it records nothing and derives no
 * claim, release or reassignment.
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
  // The org's transfer chains (R52) — org-scoped and UNCAPPED, so every claim is reconciled against every reassignment
  // that names it (the current-owner fold re-sorts each coordination's chain to pick the latest holder).
  const { data: reassignmentData, error: reassignmentError } = await reassignmentsLedger()
    .select(REASSIGNMENT_COLUMNS)
    .eq("org_id", input.org_id);
  if (reassignmentError) {
    throw new Error(
      "receptionist_conversation_claim_reassignments read failed: " + reassignmentError.message,
    );
  }
  return reconcileOwnershipStates(data ?? [], releaseData ?? [], reassignmentData ?? []);
}
