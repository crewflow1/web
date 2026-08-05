import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  projectCoordinationRecord,
  orderCoordinationRecords,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";

// =====================================================================
// THE CONVERSATION COORDINATION READ MODEL — SERVER READER (CEO Directive #018, R37: CONVERSATION
// COORDINATION READ MODEL).
//
// R36 records Conversation Coordination decisions into the append-only, service-role-only
// `receptionist_conversation_coordinations` ledger. This module is the canonical READ layer over it —
// the SINGLE, authorised query surface for those recorded decisions. No future operational capability
// (a work queue, a dashboard, an automation) queries the coordination ledger directly or rolls its own
// reconstruction: every consumer reads THROUGH the functions here, which read THROUGH the one
// `security_invoker` projection shipped by migration 20260906000000:
//   • receptionist_coordination_read_model — one row per recorded coordination: its RECORDED decision
//     (mode / lead participant / participation plan / requires-human / autonomous) surfaced directly
//     from the ledger, and its LINKED per-engine context (orchestration → lifecycle → resolution →
//     recovery → verification → fulfilment) resolved BY REFERENCE at read time.
//
// IT IS READ-ONLY, AND A PROJECTION — NOT BEHAVIOUR. It coordinates nothing, executes nothing, routes
// nothing, notifies no one, writes to no ledger and mutates no row — it only SELECTs from the view and
// maps each row through the pure {@link projectCoordinationRecord}. The Coordination Engine (R36)
// remains the SOLE authority over the decision: this reader re-derives NOTHING (it never names
// `resolveConversationCoordination`, never re-folds a mode, never recomputes a lead), and it names NO
// write primitive of ANY engine (not the coordination writer, not the orchestration / lifecycle /
// resolution / recovery / verification / fulfilment writers) — there is provably no execution path
// here. Lifecycle, Resolution and Recovery remain authoritative for the same reason: this reads their
// recorded context, it never re-governs, re-resolves or re-recovers.
//
// EVERY READ IS ORGANISATION-SCOPED. The org_id filter is MANDATORY on every query, so one
// organisation can never read another's coordinations, and `security_invoker = true` means the view
// runs with the caller's privileges and can never launder a JWT client past the base tables' RLS deny.
// The canonical coordination ORDER (newest first, stable tiebreak on coordination id) is defined in
// exactly ONE place — the pure `orderCoordinationRecords` — so a set of coordinations always
// reconstructs IDENTICALLY.
//
// The view is a service-role-only internal (not in the generated Database types), so each query casts
// past the typed client with the same `as never` / `as unknown as` convention the R11 conversation
// read model uses to read `receptionist_conversation_timeline`.
// =====================================================================

/** Every column the `receptionist_coordination_read_model` view exposes, in view order. */
const READ_MODEL_COLUMNS =
  "coordination_id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, " +
  "action_id, execution_id, orchestration_id, lifecycle_id, resolution_id, recovery_id, " +
  "authorisation_id, verification_id, fulfilment_id, review_audit_id, sent_audit_id, " +
  "review_resolution_id, coordination_type, coordination_outcome, coordination_mode, " +
  "lead_participant, participant_count, requires_human, autonomous, orchestration_route, " +
  "lifecycle_state, approval_state, coordination_status, job_type, postcode, phone_number, " +
  "coordination_at, orchestration_type, orchestration_outcome, orchestration_target, " +
  "orchestration_concluded, orchestration_active, orchestration_status, orchestration_at, " +
  "lifecycle_type, lifecycle_outcome, lifecycle_transition, lifecycle_closed, lifecycle_ongoing, " +
  "lifecycle_status, lifecycle_at, resolution_type, resolution_outcome, resolution_state, " +
  "resolution_terminal, resolution_intervention_required, resolution_recovery_classification, " +
  "resolution_status, resolution_at, recovery_type, recovery_outcome, recovery_classification, " +
  "recovery_required, recovery_integrity, recovery_status, recovery_at, verification_type, " +
  "verification_outcome, verification_integrity, verification_status, verification_at, " +
  "fulfilment_type, fulfilment_outcome, fulfilment_status, fulfilment_at";

// The view is not in the generated Database types — cast past the typed client to the minimal
// chainable surface these reads use (the same convention the R11 read model uses). The builder is a
// thenable, so the interface extends PromiseLike and `await` yields the { data, error } envelope.
type ReadResult<Row> = { data: Row[] | null; error: { message: string } | null };
interface ReadQuery<Row> extends PromiseLike<ReadResult<Row>> {
  select(columns: string): ReadQuery<Row>;
  eq(column: string, value: string): ReadQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): ReadQuery<Row>;
  limit(count: number): ReadQuery<Row>;
}

function readModelView(): ReadQuery<CoordinationReadRow> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_coordination_read_model" as never,
  ) as unknown as ReadQuery<CoordinationReadRow>;
}

/**
 * The most recently recorded coordinations for an organisation, newest first. THE coordination index —
 * every recorded coordination decision, its mode / lead / plan / flags and its linked per-engine
 * context. Org-scoped: the org_id filter is mandatory, so one org can never read another's
 * coordinations. Deterministic: the rows are ordered canonically by `orderCoordinationRecords`.
 * Capped by `limit` (default 100).
 */
export async function listCoordinations(input: {
  org_id: string;
  limit?: number;
}): Promise<CoordinationRecord[]> {
  // F-1: bounded sample — cap provably, PostgREST clamps every read to 1000.
  const limit = Math.min(input.limit ?? 100, 1000);
  const { data, error } = await readModelView()
    .select(READ_MODEL_COLUMNS)
    .eq("org_id", input.org_id)
    .order("coordination_at", { ascending: false })
    .order("coordination_id", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error("receptionist_coordination_read_model read failed: " + error.message);
  }
  return orderCoordinationRecords((data ?? []).map(projectCoordinationRecord));
}

/**
 * The recorded coordinations of ONE conversation, newest first. Org-scoped AND conversation-scoped, so
 * a caller can only ever read coordinations that belong to it. Deterministic order.
 */
export async function listCoordinationsForConversation(input: {
  org_id: string;
  conversation_id: string;
}): Promise<CoordinationRecord[]> {
  const { data, error } = await readModelView()
    .select(READ_MODEL_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("conversation_id", input.conversation_id)
    .order("coordination_at", { ascending: false })
    .order("coordination_id", { ascending: false });
  if (error) {
    throw new Error("receptionist_coordination_read_model read failed: " + error.message);
  }
  return orderCoordinationRecords((data ?? []).map(projectCoordinationRecord));
}

/**
 * One recorded coordination by its ledger id, or null if it does not exist in this organisation.
 * Org-scoped, so a caller can only ever resolve a coordination that belongs to it.
 */
export async function getCoordinationById(input: {
  org_id: string;
  coordination_id: string;
}): Promise<CoordinationRecord | null> {
  const { data, error } = await readModelView()
    .select(READ_MODEL_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("coordination_id", input.coordination_id)
    .limit(1);
  if (error) {
    throw new Error("receptionist_coordination_read_model read failed: " + error.message);
  }
  const row = data?.[0];
  return row ? projectCoordinationRecord(row) : null;
}

/**
 * The coordination a routed orchestration produced, or null. The coordination ledger's
 * `orchestration_id` is UNIQUE (a routed orchestration is coordinated AT MOST ONCE), so this resolves
 * the single coordination for an orchestration — the natural "given a routed orchestration, how was
 * the response coordinated?" lookup for a future operational capability. Org-scoped.
 */
export async function getCoordinationByOrchestration(input: {
  org_id: string;
  orchestration_id: string;
}): Promise<CoordinationRecord | null> {
  const { data, error } = await readModelView()
    .select(READ_MODEL_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("orchestration_id", input.orchestration_id)
    .limit(1);
  if (error) {
    throw new Error("receptionist_coordination_read_model read failed: " + error.message);
  }
  const row = data?.[0];
  return row ? projectCoordinationRecord(row) : null;
}
