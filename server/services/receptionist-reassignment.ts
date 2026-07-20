import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveReassignment,
  isReassignmentDecided,
  type ReassignmentType,
  type ReassignmentOutcome,
  type ReassignmentResolution,
} from "@/lib/receptionist/conversation-reassignment";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

// =====================================================================
// THE CONVERSATION WORK REASSIGNMENT — SERVER RUNTIME (CEO Directive #018, R52: CONVERSATION WORK REASSIGNMENT).
//
// The pure core (lib/receptionist/conversation-reassignment.ts) RESOLVES a reassignment DECISION from a reassignment
// request — it names the `reassign_conversation_work` reassignment ONLY when the request is well-formed (an
// organisation, a coordination, a source operator and a DISTINCT target operator are all present), but it deliberately
// PERSISTS NOTHING and reaches NO I/O. This module is the reassignment's SERVER RUNTIME, and it does exactly ONE thing:
// when a human operator TRANSFERS a coordinated Conversation Worklist item they hold to another named operator, it
// RECORDS that transfer — it files ONE durable, append-only, OWNERSHIP-GUARDED reassignment row — and STOPS. It becomes
// the ONLY authorised mechanism for transferring ownership of a Conversation Work item between operators.
//
// IT RECORDS A TRANSFER — AND IT IS DRIVEN BY AN AUTHENTICATED OPERATOR, NOT BY A TURN. Like the R46 claim runtime and
// the R50 release runtime (and unlike the R26–R36 reply-pipeline runtimes), this runtime is invoked by an OPERATOR
// ACTION: a human operator, already authenticated by the EXISTING HQ gate, hands a work item they hold to another
// operator. The caller supplies the source operator's identity (the `user.id` + `user.email` the HQ gate resolved), the
// TARGET operator's identity, and the organisation (resolved from the SESSION, never from any client input) alongside
// the coordination being transferred — so the runtime never itself decides WHO the operators are or WHICH tenant they
// act for; it records the transfer the authenticated caller asked for.
//
// THE CLAIM, RELEASE AND OWNERSHIP STATE ENGINES ALL REMAIN AUTHORITATIVE — THIS RUNTIME NEVER DERIVES OWNERSHIP. It
// records a transfer AGAINST an already-recorded claim (by its `coordination_id`); it does not read, re-decide or assert
// ownership. The SECURITY DEFINER writer is the guard: it refuses to file a reassignment unless the named coordination
// is a REAL row in the R36 ledger THAT BELONGS TO THE REASSIGNING ORGANISATION, carries an active R46 claim in that
// organisation, has NOT been released, AND is CURRENTLY HELD BY THE SOURCE OPERATOR (the latest reassignment's new
// owner, or the original claimant when never reassigned). So a reassignment can be filed only against an item the
// operator's org owns and the source operator holds — a cross-tenant transfer, or a transfer of an item held by someone
// else, is refused at the storage layer, and this runtime simply reports it (`unavailable` / `not_owned`).
//
// THE OWNERSHIP READ MODEL REMAINS AUTHORITATIVE — THIS RUNTIME READS NO OWNERSHIP. It never queries the claim ledger,
// the release ledger, the reassignment ledger or the R48 read model to decide anything: it hands the request to the pure
// core, files one row through the primitive, and reports the resolution. The item stays `claimed` throughout a transfer
// (a reassignment adds NO state to the R51 ownership lifecycle) — this runtime records WHO now holds it; the derivation
// above reflects it.
//
// THE LEDGER ROW IS BOTH THE REASSIGNMENT RECORD AND ITS AUDIT — AND INVALID TRANSFERS ARE PREVENTED BY CONSTRUCTION.
// When the pure core decides `reassign_conversation_work`, this runtime files exactly ONE row into the append-only
// `receptionist_conversation_claim_reassignments` ledger through the single service-role-only SECURITY DEFINER primitive
// `record_receptionist_conversation_claim_reassignment` — threaded to the coordination it is filed against
// (`coordination_id`, NOT unique — a chain of transfers is allowed) and the claim it transfers. The primitive inserts ON
// CONFLICT (request_id) DO NOTHING: a replay of the SAME request returns the existing id (idempotent → `reassigned`). An
// attempt to transfer an item with no claim, a released item, or one held by a DIFFERENT operator than the named source
// returns NULL (refused → `not_owned`). Invalid transfers can never write a row. Ownership guarding is NOT retry: this
// runtime attempts the write once and lets the ledger refuse; it orchestrates no re-attempt.
//
// IT PERFORMS NO BUSINESS OPERATION — IT DISPATCHES, NOTIFIES, SCHEDULES, COMPLETES AND CLOSES NOTHING, AND IT ASSIGNS
// NOTHING AUTOMATICALLY. It never dispatches work, never notifies a user, never schedules anything, never fulfils a
// quote, never promotes a customer, never completes work, never closes a conversation, and never auto-assigns from a
// queue — every one is an EXPLICIT R52 non-goal. It records that a human operator has transferred ownership to another
// named operator, and nothing else follows from it here: the item stays claimed, now by the target operator.
//
// IT IS BEST-EFFORT — IT NEVER THROWS. Every path is wrapped: a malformed request, a missing coordination, a non-owner
// attempt or a failed ledger write all return a `ReassignmentResult` (never an exception), so a reassignment attempt can
// never crash the operator surface that invoked it. A refused transfer is a normal, reported outcome (`not_owned`), not
// an error.
// =====================================================================

/**
 * The inputs {@link reassignConversationWork} needs to record a reassignment: the organisation the transfer is scoped to
 * (resolved from the SESSION by the caller, never from client input), the recorded coordination being transferred, the
 * authenticated SOURCE operator (the `user.id` + `user.email` the HQ gate resolved) and the TARGET operator receiving
 * the item. An OPTIONAL `request_id` is the idempotency key — supply a stable one (e.g. derived from the operator UI
 * action) so a retried transfer is a no-op that returns the same id; omit it and the primitive generates a fresh one,
 * making each call a distinct transfer attempt. The conversation and correlation ids are OPTIONAL provenance threaded
 * onto the audit row for cross-reference.
 */
export type ReassignmentTrigger = {
  /** The organisation the transfer is scoped to — resolved from the operator's session, never from client input. */
  readonly org_id: string;
  /** The recorded R36 coordination the transfer is filed against. */
  readonly coordination_id: string;
  /** The authenticated SOURCE operator giving the item up — the HQ gate's `user.id` + `user.email`. */
  readonly from_operator: OperatorIdentity;
  /** The TARGET operator receiving the item — the new owner. */
  readonly to_operator: OperatorIdentity;
  /** OPTIONAL idempotency key — a stable request id makes a retried transfer a no-op returning the same id. */
  readonly request_id?: string | null;
  /** OPTIONAL provenance — the conversation the coordination concerns. */
  readonly conversation_id?: string | null;
  /** OPTIONAL provenance — the end-to-end trace id. */
  readonly correlation_id?: string | null;
};

/**
 * The durable reference to a recorded reassignment — the ledger row id, the coordination it is filed against, the source
 * and target operators it records, and its fold.
 */
export type RecordedReassignment = {
  /** The id of the append-only `receptionist_conversation_claim_reassignments` row (stable across an idempotent replay). */
  readonly reassignment_id: string;
  /** The coordination the transfer is filed against. */
  readonly coordination_id: string;
  /** The PREVIOUS owner — the operator who gave the item up. */
  readonly from_operator_id: string;
  /** The NEW owner — the operator the item was handed to. */
  readonly to_operator_id: string;
  /** The reassignment type that was recorded. */
  readonly reassignment_type: ReassignmentType;
  /** The recorded outcome (`work_reassigned`). */
  readonly reassignment_outcome: ReassignmentOutcome;
};

/**
 * The result of a reassignment attempt — a discriminated union over the closed {@link ReassignmentResolution}
 * vocabulary:
 *   • `reassigned`   — the transfer was recorded (or the same request was replayed); carries the
 *                      {@link RecordedReassignment} (with a STABLE id across an idempotent replay). The item is now held
 *                      by the target operator.
 *   • `not_owned`    — the item cannot be transferred by this operator (it carries no active claim, it has been released,
 *                      or its ownership is held by a DIFFERENT operator than the named source); nothing was written.
 *   • `unavailable`  — the transfer could not be recorded (ill-shaped request, the coordination does not exist in the
 *                      operator's organisation, or the ledger write failed). Best-effort — never an exception.
 */
export type ReassignmentResult =
  | {
      readonly resolution: Extract<ReassignmentResolution, "reassigned">;
      readonly reassignment: RecordedReassignment;
    }
  | { readonly resolution: Extract<ReassignmentResolution, "not_owned"> }
  | { readonly resolution: Extract<ReassignmentResolution, "unavailable"> };

// The write primitive is service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_claim` and the other ledger writers.
type RecordReassignmentRpc = (
  fn: "record_receptionist_conversation_claim_reassignment",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record an operator's REASSIGNMENT of a coordinated Conversation Worklist item to another operator — THE single entry
 * point an operator action calls, and the ONLY authorised mechanism for transferring ownership of a Conversation Work
 * item between operators. Hands the request to the pure {@link resolveReassignment} (which validates its SHAPE, including
 * that the source and target operators DIFFER), and when — and only when — the pure core names a reassignment, files ONE
 * ownership-guarded row into the append-only reassignment ledger through the service-role-only SECURITY DEFINER
 * primitive.
 *
 * The primitive is the guard that keeps the Claim, Release and Ownership State engines authoritative and organisation
 * isolation structural: it refuses to write unless the named coordination is a REAL row in the reassigning organisation
 * that carries an active, un-released claim CURRENTLY HELD BY THE SOURCE OPERATOR. Invalid transfers are prevented by
 * that ownership gate: an item with no claim, a released item, or one held by a different operator returns `not_owned`
 * and writes nothing. A replay of the same request is idempotent (`reassigned`, stable id).
 *
 * BEST-EFFORT: every path returns a {@link ReassignmentResult} and never throws — a reassignment attempt can never crash
 * the surface that invoked it. Returns `unavailable` when the request is ill-shaped, when the coordination does not
 * exist in the operator's organisation, or when the ledger write failed; `not_owned` when the source operator does not
 * hold the item; `reassigned` (with the {@link RecordedReassignment}) when the transfer was recorded.
 */
export async function reassignConversationWork(
  input: ReassignmentTrigger,
): Promise<ReassignmentResult> {
  try {
    // THE PURE DECISION — validate the SHAPE of the request. An abstention (a missing org, coordination, source or target
    // operator, or a source that equals the target) is reported as `unavailable`: there was nothing well-formed to
    // record.
    const decision = resolveReassignment({
      org_id: input.org_id,
      coordination_id: input.coordination_id,
      from_operator: input.from_operator,
      to_operator: input.to_operator,
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
    });
    if (!isReassignmentDecided(decision)) return { resolution: "unavailable" };

    // RECORD the transfer — file ONE ownership-guarded row through the service-role-only SECURITY DEFINER primitive. The
    // primitive enforces coordination authority + org isolation (the coordination must be real and in this org) and the
    // ownership gate (the coordination must carry an active, un-released claim currently held by the SOURCE operator).
    const admin = createAdminClient();
    const writer = admin.rpc.bind(admin) as unknown as RecordReassignmentRpc;
    const { data, error } = await writer(
      "record_receptionist_conversation_claim_reassignment",
      {
        p_org_id: decision.org_id,
        p_coordination_id: decision.coordination_id,
        p_from_operator_id: decision.from_operator.id,
        p_to_operator_id: decision.to_operator.id,
        p_reassignment_type: decision.kind,
        p_reassignment_outcome: decision.outcome,
        p_from_operator_email: decision.from_operator.email,
        p_to_operator_email: decision.to_operator.email,
        p_conversation_id: input.conversation_id ?? null,
        p_correlation_id: input.correlation_id ?? null,
        p_request_id: input.request_id ?? null,
        p_metadata: {},
      },
    );

    // A raised error is the primitive's refusal — an unknown coordination, a cross-tenant attempt, or a bad vocabulary.
    // It is reported as `unavailable` (logged, never thrown): the transfer simply went unrecorded.
    if (error) {
      console.error("[receptionist] reassignment write failed:", error.message);
      return { resolution: "unavailable" };
    }

    // A NULL id (with NO error) is the ownership refusal: the item carries no active claim, has been released, or its
    // ownership is held by a DIFFERENT operator than the named source. Nothing was written; reported as `not_owned`.
    if (!data) return { resolution: "not_owned" };

    // A returned id is the recorded reassignment (or the same request's idempotent replay, with a stable id).
    return {
      resolution: "reassigned",
      reassignment: {
        reassignment_id: data,
        coordination_id: decision.coordination_id,
        from_operator_id: decision.from_operator.id,
        to_operator_id: decision.to_operator.id,
        reassignment_type: decision.kind,
        reassignment_outcome: decision.outcome,
      },
    };
  } catch (e) {
    console.error(
      "[receptionist] conversation reassignment threw:",
      e instanceof Error ? e.message : String(e),
    );
    return { resolution: "unavailable" };
  }
}
