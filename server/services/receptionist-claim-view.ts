import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  projectClaimOwner,
  type ClaimOwnerRow,
  type ClaimOwnerRecord,
} from "@/lib/receptionist/conversation-claim-view";

// =====================================================================
// THE CONVERSATION WORK CLAIM SURFACE — SERVER OWNERSHIP READER (CEO Directive #018, R47: CONVERSATION WORK CLAIM
// SURFACE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item into the append-only, service-role-only
// `receptionist_conversation_claims` ledger (one row per coordination, `coordination_id` UNIQUE). R47 is the FIRST
// operator-facing use of that capability, and the surface must DISPLAY the current owner. This module is that display's
// READ layer — the SINGLE authorised query surface for a recorded claim's OWNERSHIP FACTS.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim, and names NO write primitive
// of ANY engine (not `record_receptionist_conversation_claim`, not any coordination / lifecycle / fulfilment writer):
// there is provably no execution path here. The R46 runtime (`claimConversationWork`) remains the SOLE authority over
// recording a claim — this reader re-derives NOTHING; it SELECTs the ledger row and maps it through the pure
// {@link projectClaimOwner}. It never itself claims, reassigns, releases, dispatches or notifies — it only answers "who
// holds this item?".
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` filter is MANDATORY on the query, so one organisation can never read
// another's claims — organisation isolation is structural here, exactly as it is on the R37 coordination reader. The
// read is ALSO coordination-scoped: because `coordination_id` is UNIQUE in the ledger, an (`org_id`, `coordination_id`)
// pair resolves AT MOST ONE claim — the single current owner of that item, or null when it is unclaimed.
//
// The claims ledger is a service-role-only internal (RLS-enabled, zero policies; not in the generated Database types),
// so the query casts past the typed client with the same `as never` / `as unknown as` convention the R37 read model
// uses to read `receptionist_coordination_read_model`.
// =====================================================================

/** Every column the ownership display needs from the `receptionist_conversation_claims` ledger, in a stable order. */
const CLAIM_OWNER_COLUMNS =
  "coordination_id, org_id, operator_id, operator_email, claim_type, claim_outcome, status, claimed_at";

// The claims ledger is not in the generated Database types — cast past the typed client to the minimal chainable
// surface this read uses (the same convention the R37 read model uses). The builder is a thenable, so the interface
// extends PromiseLike and `await` yields the { data, error } envelope.
type ReadResult<Row> = { data: Row[] | null; error: { message: string } | null };
interface ReadQuery<Row> extends PromiseLike<ReadResult<Row>> {
  select(columns: string): ReadQuery<Row>;
  eq(column: string, value: string): ReadQuery<Row>;
  limit(count: number): ReadQuery<Row>;
}

function claimsLedger(): ReadQuery<ClaimOwnerRow> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claims" as never,
  ) as unknown as ReadQuery<ClaimOwnerRow>;
}

/**
 * The current claim on ONE coordinated item, or null if it is unclaimed in this organisation. THE ownership lookup the
 * Claim Surface renders — who holds this coordination's work item. Org-scoped: the `org_id` filter is MANDATORY, so one
 * org can never read another's claims. Coordination-scoped and single-valued: `coordination_id` is UNIQUE in the
 * ledger, so this resolves AT MOST ONE claim — the single current owner, or null.
 *
 * READ-ONLY: it SELECTs the recorded claim and projects it through the pure {@link projectClaimOwner}; it records
 * nothing and decides no claim. The R46 runtime remains authoritative over recording a claim; this only reads back the
 * fact one exists.
 */
export async function getClaimForCoordination(input: {
  org_id: string;
  coordination_id: string;
}): Promise<ClaimOwnerRecord | null> {
  const { data, error } = await claimsLedger()
    .select(CLAIM_OWNER_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("coordination_id", input.coordination_id)
    .limit(1);
  if (error) {
    throw new Error("receptionist_conversation_claims read failed: " + error.message);
  }
  const row = data?.[0];
  return row ? projectClaimOwner(row) : null;
}
