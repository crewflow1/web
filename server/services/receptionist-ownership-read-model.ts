import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — SERVER READER (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL; release-aware since R50: CONVERSATION WORK RELEASE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item into the append-only, service-role-only
// `receptionist_conversation_claims` ledger (one row per coordination, `coordination_id` UNIQUE). R50 records an
// operator's RELEASE of that claim into the append-only, service-role-only `receptionist_conversation_claim_releases`
// ledger (one row per coordination, `coordination_id` UNIQUE). R48 establishes the CANONICAL OWNERSHIP READ MODEL over
// those ledgers — the SINGLE authoritative read layer for ownership FACTS. No future operational capability (a My-Claims
// list, an ownership dashboard, an operator queue) queries the ledgers for ownership directly or rolls its own
// reconstruction: every consumer reads THROUGH the seams here, which map ledger rows through the pure
// {@link projectOwnership} / {@link projectOwnershipEvent} / {@link summariseOwnership} / {@link selectActiveClaims}.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim and decides no release, and
// names NO write primitive of ANY engine (not `record_receptionist_conversation_claim`, not
// `record_receptionist_conversation_claim_release`, not any coordination / lifecycle / fulfilment writer): there is
// provably no execution path here. The R46 runtime (`claimConversationWork`) remains the SOLE authority over recording a
// claim, and the R50 runtime (`releaseConversationWork`) the SOLE authority over recording a release — this reader
// re-derives NOTHING; it SELECTs the ledger row(s) and projects them. It never itself claims, releases, reassigns,
// dispatches or notifies — it only answers "who owns this?", "what is the ownership history?" and "what does ownership
// look like across the organisation?".
//
// IT CONSUMES ONLY THE TWO APPEND-ONLY LEDGERS — THE CLAIMS LEDGER AND ITS RELEASES LEDGER. Every read is a SELECT
// against `receptionist_conversation_claims` or `receptionist_conversation_claim_releases` and no other table: the read
// model derives no coordination, reads no sibling engine and reaches no view. Because both ledgers are append-only and
// `coordination_id` is UNIQUE in each, a coordination has AT MOST ONE claim row and AT MOST ONE release row — so
// per-coordination ownership is a single claim row MINUS its release (owned IFF a claim is present AND no release is),
// and org-wide history / summary are folds over the org's ACTIVE claims (its claims whose coordination has NOT been
// released, selected by the pure `selectActiveClaims`). A released item returns to the unclaimed state HERE, in the read
// model's derivation — the append-only claim ledger is never mutated.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` filter is MANDATORY on every query — every claims read AND every
// releases read — so one organisation can never read another's ownership: organisation isolation is structural here,
// exactly as it is on the R37 coordination reader and the R47 claim reader. The history order (newest claim first,
// stable tiebreak on coordination id) is defined in exactly ONE place — the pure `orderOwnershipEvents` — and the
// summary fold is order-independent, so a set of claims always reconstructs IDENTICALLY.
//
// Both ledgers are service-role-only internals (RLS-enabled, zero policies; not in the generated Database types), so
// each query casts past the typed client with the same `as never` / `as unknown as` convention the R47 claim reader and
// the R37 read model use.
// =====================================================================

/** Every column the ownership read model needs from the `receptionist_conversation_claims` ledger, in a stable order. */
const OWNERSHIP_COLUMNS =
  "coordination_id, org_id, conversation_id, correlation_id, operator_id, operator_email, " +
  "claim_type, claim_outcome, status, claimed_at";

/**
 * Every column the read model needs from the `receptionist_conversation_claim_releases` ledger, in a stable order. Only
 * the coordination + org are load-bearing for the ownership derivation (a release SUBTRACTS its coordination from
 * ownership); the operator + instant are carried for a faithful row shape.
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

function claimsLedger(): ReadQuery<OwnershipClaimRow> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claims" as never,
  ) as unknown as ReadQuery<OwnershipClaimRow>;
}

function releasesLedger(): ReadQuery<OwnershipReleaseRow> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_claim_releases" as never,
  ) as unknown as ReadQuery<OwnershipReleaseRow>;
}

/**
 * The ownership of ONE coordination in an organisation — the current owner, the claim timestamp and the ownership
 * status (`owned` / `unowned`). THE per-item ownership lookup: who owns this coordination's work item. Org-scoped: the
 * `org_id` filter is MANDATORY on BOTH reads, so one org can never read another's ownership. Single-valued:
 * `coordination_id` is UNIQUE in each ledger, so this resolves AT MOST ONE claim row and AT MOST ONE release row — a
 * present claim with NO release is `owned`; the claim's absence, OR a present release, is `unowned` (a released item has
 * returned to the unclaimed state).
 *
 * READ-ONLY: it SELECTs the recorded claim and the recorded release (or reads their absence) and projects them through
 * the pure {@link projectOwnership}; it records nothing, decides no claim and decides no release. The R46 runtime
 * remains authoritative over recording a claim and the R50 runtime over recording a release; this only reads back the
 * ownership fact.
 */
export async function getOwnership(input: {
  org_id: string;
  coordination_id: string;
}): Promise<OwnershipRecord> {
  const { data, error } = await claimsLedger()
    .select(OWNERSHIP_COLUMNS)
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
  const claim = data?.[0] ?? null;
  const release = releaseData?.[0] ?? null;
  return projectOwnership({ coordinationId: input.coordination_id, claim, release });
}

/**
 * The organisation's ownership HISTORY — every CURRENT ownership event (one per recorded claim whose coordination has
 * NOT been released), newest first. THE ownership audit trail: who holds ownership of what, and since when. Org-scoped:
 * the `org_id` filter is MANDATORY on BOTH reads, so one org can never read another's history. Release-aware: a
 * coordination whose claim has been relinquished (a release row names it) is SUBTRACTED via the pure
 * {@link selectActiveClaims} before ordering, so it is no longer a current ownership event. Deterministic: the surviving
 * rows are ordered canonically by {@link orderOwnershipEvents} (newest claim first, stable tiebreak on coordination
 * id). Capped by `limit` (default 100) on the claim rows examined.
 *
 * READ-ONLY: it SELECTs the recorded claims and releases, subtracts the released, and projects each survivor through the
 * pure {@link projectOwnershipEvent}; it records nothing and derives no claim or release.
 */
export async function getOwnershipHistory(input: {
  org_id: string;
  limit?: number;
}): Promise<OwnershipEvent[]> {
  const limit = input.limit ?? 100;
  const { data, error } = await claimsLedger()
    .select(OWNERSHIP_COLUMNS)
    .eq("org_id", input.org_id)
    .order("claimed_at", { ascending: false })
    .order("coordination_id", { ascending: false })
    .limit(limit);
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
  const active = selectActiveClaims(data ?? [], releaseData ?? []);
  return orderOwnershipEvents(active.map(projectOwnershipEvent));
}

/**
 * The organisation's ownership SUMMARY — aggregates over every CURRENTLY-OWNED coordination in the org (a claim whose
 * coordination has NOT been released): total claims, distinct owners, the per-owner tallies, and the latest / earliest
 * claim instants. THE ownership overview a future dashboard reads. Org-scoped: the `org_id` filter is MANDATORY on BOTH
 * reads, so one org can never read another's ownership. Release-aware: the released coordinations are SUBTRACTED via the
 * pure {@link selectActiveClaims} before the fold, so a relinquished item counts toward no tally. Deterministic: the
 * fold {@link summariseOwnership} is order-independent, so the summary never depends on how the database returned the
 * rows. Unlike the history read, NEITHER read is capped — an accurate aggregate must see every claim AND every release
 * in the organisation.
 *
 * READ-ONLY: it SELECTs the recorded claims and releases, subtracts the released, and folds the survivors through the
 * pure {@link summariseOwnership}; it records nothing and derives no claim or release.
 */
export async function getOwnershipSummary(input: { org_id: string }): Promise<OwnershipSummary> {
  const { data, error } = await claimsLedger()
    .select(OWNERSHIP_COLUMNS)
    .eq("org_id", input.org_id);
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
  return summariseOwnership(selectActiveClaims(data ?? [], releaseData ?? []));
}
