import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  projectOwnership,
  projectOwnershipEvent,
  orderOwnershipEvents,
  summariseOwnership,
  type OwnershipClaimRow,
  type OwnershipRecord,
  type OwnershipEvent,
  type OwnershipSummary,
} from "@/lib/receptionist/conversation-ownership-read-model";

// =====================================================================
// THE CONVERSATION WORK OWNERSHIP READ MODEL — SERVER READER (CEO Directive #018, R48: CONVERSATION WORK OWNERSHIP READ
// MODEL).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item into the append-only, service-role-only
// `receptionist_conversation_claims` ledger (one row per coordination, `coordination_id` UNIQUE). R48 establishes the
// CANONICAL OWNERSHIP READ MODEL over that ledger — the SINGLE authoritative read layer for ownership FACTS. No future
// operational capability (a My-Claims list, an ownership dashboard, an operator queue) queries the claim ledger for
// ownership directly or rolls its own reconstruction: every consumer reads THROUGH the seams here, which map ledger
// rows through the pure {@link projectOwnership} / {@link projectOwnershipEvent} / {@link summariseOwnership}.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It records nothing, decides no claim, and names NO write primitive
// of ANY engine (not `record_receptionist_conversation_claim`, not any coordination / lifecycle / fulfilment writer):
// there is provably no execution path here. The R46 runtime (`claimConversationWork`) remains the SOLE authority over
// recording a claim — this reader re-derives NOTHING; it SELECTs the ledger row(s) and projects them. It never itself
// claims, reassigns, releases, dispatches or notifies — it only answers "who owns this?", "what is the ownership
// history?" and "what does ownership look like across the organisation?".
//
// IT CONSUMES ONLY THE APPEND-ONLY CLAIM LEDGER. Every read is a SELECT against `receptionist_conversation_claims` and
// no other table: the read model derives no coordination, reads no sibling engine and reaches no view. Because the
// ledger is append-only and `coordination_id` is UNIQUE, a coordination has at most one claim row — so per-coordination
// ownership is a single row, and org-wide history / summary are folds over the org's claim rows.
//
// EVERY READ IS ORGANISATION-SCOPED. The `org_id` filter is MANDATORY on every query, so one organisation can never
// read another's ownership — organisation isolation is structural here, exactly as it is on the R37 coordination reader
// and the R47 claim reader. The history order (newest claim first, stable tiebreak on coordination id) is defined in
// exactly ONE place — the pure `orderOwnershipEvents` — and the summary fold is order-independent, so a set of claims
// always reconstructs IDENTICALLY.
//
// The claims ledger is a service-role-only internal (RLS-enabled, zero policies; not in the generated Database types),
// so each query casts past the typed client with the same `as never` / `as unknown as` convention the R47 claim reader
// and the R37 read model use.
// =====================================================================

/** Every column the ownership read model needs from the `receptionist_conversation_claims` ledger, in a stable order. */
const OWNERSHIP_COLUMNS =
  "coordination_id, org_id, conversation_id, correlation_id, operator_id, operator_email, " +
  "claim_type, claim_outcome, status, claimed_at";

// The claims ledger is not in the generated Database types — cast past the typed client to the minimal chainable
// surface these reads use (the same convention the R47 claim reader / R37 read model use). The builder is a thenable,
// so the interface extends PromiseLike and `await` yields the { data, error } envelope.
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

/**
 * The ownership of ONE coordination in an organisation — the current owner, the claim timestamp and the ownership
 * status (`owned` / `unowned`). THE per-item ownership lookup: who owns this coordination's work item. Org-scoped: the
 * `org_id` filter is MANDATORY, so one org can never read another's ownership. Single-valued: `coordination_id` is
 * UNIQUE in the ledger, so this resolves AT MOST ONE claim row — a present row is `owned`, its absence is `unowned`.
 *
 * READ-ONLY: it SELECTs the recorded claim (or reads its absence) and projects it through the pure
 * {@link projectOwnership}; it records nothing and decides no claim. The R46 runtime remains authoritative over
 * recording a claim; this only reads back the ownership fact.
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
  const claim = data?.[0] ?? null;
  return projectOwnership({ coordinationId: input.coordination_id, claim });
}

/**
 * The organisation's ownership HISTORY — every ownership event (one per recorded claim), newest first. THE ownership
 * audit trail: who took ownership of what, and when. Org-scoped: the `org_id` filter is MANDATORY, so one org can never
 * read another's history. Deterministic: the rows are ordered canonically by `orderOwnershipEvents` (newest claim
 * first, stable tiebreak on coordination id). Capped by `limit` (default 100).
 *
 * READ-ONLY: it SELECTs the recorded claims and projects each through the pure {@link projectOwnershipEvent}; it records
 * nothing and derives no claim.
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
  return orderOwnershipEvents((data ?? []).map(projectOwnershipEvent));
}

/**
 * The organisation's ownership SUMMARY — aggregates over every claim in the org: total claims, distinct owners, the
 * per-owner tallies, and the latest / earliest claim instants. THE ownership overview a future dashboard reads.
 * Org-scoped: the `org_id` filter is MANDATORY, so one org can never read another's ownership. Deterministic: the fold
 * {@link summariseOwnership} is order-independent, so the summary never depends on how the database returned the rows.
 * Unlike the history read, the summary is NOT capped — an accurate aggregate must see every claim in the organisation.
 *
 * READ-ONLY: it SELECTs the recorded claims and folds them through the pure {@link summariseOwnership}; it records
 * nothing and derives no claim.
 */
export async function getOwnershipSummary(input: { org_id: string }): Promise<OwnershipSummary> {
  const { data, error } = await claimsLedger()
    .select(OWNERSHIP_COLUMNS)
    .eq("org_id", input.org_id);
  if (error) {
    throw new Error("receptionist_conversation_claims read failed: " + error.message);
  }
  return summariseOwnership(data ?? []);
}
