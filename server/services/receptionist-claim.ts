import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveClaim,
  isClaimDecided,
  type ClaimType,
  type ClaimOutcome,
  type ClaimResolution,
  type OperatorIdentity,
} from "@/lib/receptionist/conversation-claim";

// =====================================================================
// THE CONVERSATION WORK CLAIM — SERVER RUNTIME (CEO Directive #018, R46: CONVERSATION WORK CLAIM).
//
// The pure core (lib/receptionist/conversation-claim.ts) RESOLVES a claim DECISION from a claim request — it names the
// `claim_conversation_work` claim ONLY when the request is well-formed (an organisation, a coordination and an
// operator identity are all present), but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the
// claim's SERVER RUNTIME, and it does exactly ONE thing: when a human operator claims a coordinated Conversation
// Worklist item, it RECORDS that ownership — it files ONE durable, append-only, CONFLICT-GUARDED claim row — and STOPS.
//
// IT RECORDS OWNERSHIP — AND IT IS DRIVEN BY AN AUTHENTICATED OPERATOR, NOT BY A TURN. Unlike the R26–R36 runtimes
// (each files a decision during the reply pipeline, driven by a conversation turn or a human's review-send), this
// runtime is invoked by an OPERATOR ACTION: a human operator, already authenticated by the EXISTING HQ gate, takes
// ownership of a work item. The caller supplies the operator's identity (the `user.id` + `user.email` the HQ gate
// resolved) and the organisation (resolved from the SESSION, never from any client input) alongside the coordination
// being claimed — so the runtime never itself decides WHO the operator is or WHICH tenant they act for; it records the
// claim the authenticated caller asked for.
//
// THE COORDINATION ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME NEVER DERIVES A COORDINATION. It records a claim
// AGAINST an already-recorded coordination (by its `coordination_id`); it does not read, re-decide or assert one. The
// SECURITY DEFINER writer is the guard: it refuses to file a claim unless the named coordination is a REAL row in the
// R36 `receptionist_conversation_coordinations` ledger THAT BELONGS TO THE CLAIMING ORGANISATION. So a claim can be
// filed only against a coordination the operator's org actually owns — a cross-tenant claim is refused at the storage
// layer, and this runtime simply reports it as `unavailable`.
//
// THE LEDGER ROW IS BOTH THE OWNERSHIP RECORD AND ITS AUDIT — AND CONFLICTS ARE PREVENTED BY CONSTRUCTION. When the
// pure core decides `claim_conversation_work`, this runtime files exactly ONE row into the append-only
// `receptionist_conversation_claims` ledger through the single service-role-only SECURITY DEFINER primitive
// `record_receptionist_conversation_claim` — threaded to the coordination it is filed against (`coordination_id`,
// UNIQUE). The primitive inserts ON CONFLICT (coordination_id) DO NOTHING: a repeat by the SAME operator returns the
// existing id (idempotent → `claimed`); an attempt by a DIFFERENT operator on an already-owned item returns NULL
// (refused → `already_claimed`). Two operators can never both hold the same item. Conflict prevention is NOT retry:
// this runtime attempts the write once and lets the ledger refuse a conflict; it orchestrates no re-attempt.
//
// IT PERFORMS NO BUSINESS OPERATION — IT ASSIGNS, DISPATCHES, NOTIFIES, SCHEDULES, COMPLETES AND CLOSES NOTHING. It
// never assigns work automatically, never dispatches it, never notifies a user, never schedules anything, never
// fulfils a quote, never promotes a customer, never completes work and never closes a conversation — every one is an
// EXPLICIT R46 non-goal. It records that a human operator has taken ownership, and nothing else follows from it here.
//
// IT IS BEST-EFFORT — IT NEVER THROWS. Every path is wrapped: a malformed request, a missing coordination, a
// cross-tenant attempt or a failed ledger write all return a `ClaimResult` (never an exception), so a claim attempt
// can never crash the operator surface that invoked it. A conflict is a normal, reported outcome (`already_claimed`),
// not an error.
// =====================================================================

/**
 * The inputs {@link claimConversationWork} needs to record a claim: the organisation the claim is scoped to (resolved
 * from the SESSION by the caller, never from client input), the recorded coordination being claimed, and the
 * authenticated operator's identity (the `user.id` + `user.email` the HQ gate resolved). The conversation and
 * correlation ids are OPTIONAL provenance threaded onto the audit row for cross-reference.
 */
export type ClaimTrigger = {
  /** The organisation the claim is scoped to — resolved from the operator's session, never from client input. */
  readonly org_id: string;
  /** The recorded R36 coordination the claim is filed against. */
  readonly coordination_id: string;
  /** The authenticated operator taking the claim — the HQ gate's `user.id` + `user.email`. */
  readonly operator: OperatorIdentity;
  /** OPTIONAL provenance — the conversation the coordination concerns. */
  readonly conversation_id?: string | null;
  /** OPTIONAL provenance — the end-to-end trace id. */
  readonly correlation_id?: string | null;
};

/** The durable reference to a recorded claim — the ledger row id, the coordination + operator it records, and its fold. */
export type RecordedClaim = {
  /** The id of the append-only `receptionist_conversation_claims` row (stable across an idempotent re-claim). */
  readonly claim_id: string;
  /** The coordination the claim is filed against. */
  readonly coordination_id: string;
  /** The operator who holds the claim. */
  readonly operator_id: string;
  /** The claim type that was recorded. */
  readonly claim_type: ClaimType;
  /** The recorded outcome (`work_claimed`). */
  readonly claim_outcome: ClaimOutcome;
};

/**
 * The result of a claim attempt — a discriminated union over the closed {@link ClaimResolution} vocabulary:
 *   • `claimed`         — the claim was recorded (or the same operator re-claimed their own item); carries the
 *                         {@link RecordedClaim} (with a STABLE id across an idempotent re-claim).
 *   • `already_claimed` — a DIFFERENT operator already holds an active claim on this item; nothing was written.
 *   • `unavailable`     — the claim could not be recorded (ill-shaped request, the coordination does not exist in the
 *                         operator's organisation, or the ledger write failed). Best-effort — never an exception.
 */
export type ClaimResult =
  | { readonly resolution: Extract<ClaimResolution, "claimed">; readonly claim: RecordedClaim }
  | { readonly resolution: Extract<ClaimResolution, "already_claimed"> }
  | { readonly resolution: Extract<ClaimResolution, "unavailable"> };

// The write primitive is service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_fulfilment` and the other ledger writers.
type RecordClaimRpc = (
  fn: "record_receptionist_conversation_claim",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record an operator's CLAIM of a coordinated Conversation Worklist item — THE single entry point an operator action
 * calls. Hands the request to the pure {@link resolveClaim} (which validates its SHAPE), and when — and only when —
 * the pure core names a claim, files ONE conflict-guarded row into the append-only claim ledger through the
 * service-role-only SECURITY DEFINER primitive.
 *
 * The primitive is the guard that keeps the Coordination Engine authoritative and organisation isolation structural:
 * it refuses to write unless the named coordination is a REAL row in the claiming organisation. Conflicting active
 * claims are prevented by the UNIQUE `coordination_id`: a repeat by the same operator is idempotent (`claimed`, stable
 * id); an attempt by a different operator is refused (`already_claimed`).
 *
 * BEST-EFFORT: every path returns a {@link ClaimResult} and never throws — a claim attempt can never crash the surface
 * that invoked it. Returns `unavailable` when the request is ill-shaped, when the coordination does not exist in the
 * operator's organisation, or when the ledger write failed; `already_claimed` when a different operator owns the item;
 * `claimed` (with the {@link RecordedClaim}) when the claim was recorded.
 */
export async function claimConversationWork(input: ClaimTrigger): Promise<ClaimResult> {
  try {
    // THE PURE DECISION — validate the SHAPE of the request. An abstention (a missing org, coordination or operator
    // identity) is reported as `unavailable`: there was nothing well-formed to record.
    const decision = resolveClaim({
      org_id: input.org_id,
      coordination_id: input.coordination_id,
      operator: input.operator,
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
    });
    if (!isClaimDecided(decision)) return { resolution: "unavailable" };

    // RECORD the ownership claim — file ONE conflict-guarded row through the service-role-only SECURITY DEFINER
    // primitive. The primitive enforces coordination authority + org isolation (the coordination must be real and in
    // this org) and conflict prevention (ON CONFLICT (coordination_id) DO NOTHING).
    const admin = createAdminClient();
    const writer = admin.rpc.bind(admin) as unknown as RecordClaimRpc;
    const { data, error } = await writer("record_receptionist_conversation_claim", {
      p_org_id: decision.org_id,
      p_coordination_id: decision.coordination_id,
      p_operator_id: decision.operator.id,
      p_claim_type: decision.kind,
      p_claim_outcome: decision.outcome,
      p_operator_email: decision.operator.email,
      p_conversation_id: input.conversation_id ?? null,
      p_correlation_id: input.correlation_id ?? null,
      p_metadata: {},
    });

    // A raised error is the primitive's refusal — an unknown coordination, a cross-tenant attempt, or a bad
    // vocabulary. It is reported as `unavailable` (logged, never thrown): the claim simply went unrecorded.
    if (error) {
      console.error("[receptionist] claim write failed:", error.message);
      return { resolution: "unavailable" };
    }

    // A NULL id (with NO error) is the conflict refusal: a DIFFERENT operator already holds this item. Nothing was
    // written; the attempt is reported as `already_claimed`.
    if (!data) return { resolution: "already_claimed" };

    // A returned id is the recorded claim (or the same operator's idempotent re-claim, with a stable id).
    return {
      resolution: "claimed",
      claim: {
        claim_id: data,
        coordination_id: decision.coordination_id,
        operator_id: decision.operator.id,
        claim_type: decision.kind,
        claim_outcome: decision.outcome,
      },
    };
  } catch (e) {
    console.error("[receptionist] conversation claim threw:", e instanceof Error ? e.message : String(e));
    return { resolution: "unavailable" };
  }
}
