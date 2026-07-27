import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveRelease,
  isReleaseDecided,
  type ReleaseType,
  type ReleaseOutcome,
  type ReleaseResolution,
} from "@/lib/receptionist/conversation-release";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

// =====================================================================
// THE CONVERSATION WORK RELEASE — SERVER RUNTIME (CEO Directive #018, R50: CONVERSATION WORK RELEASE).
//
// The pure core (lib/receptionist/conversation-release.ts) RESOLVES a release DECISION from a release request — it names
// the `release_conversation_work` release ONLY when the request is well-formed (an organisation, a coordination and an
// operator identity are all present), but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the
// release's SERVER RUNTIME, and it does exactly ONE thing: when a human operator RELINQUISHES a coordinated
// Conversation Worklist item they own, it RECORDS that relinquish — it files ONE durable, append-only,
// OWNERSHIP-GUARDED release row — and STOPS. It becomes the ONLY authorised mechanism for an operator to relinquish
// ownership of a Conversation Work item.
//
// IT RECORDS A RELINQUISH — AND IT IS DRIVEN BY AN AUTHENTICATED OPERATOR, NOT BY A TURN. Like the R46 claim runtime
// (and unlike the R26–R36 reply-pipeline runtimes), this runtime is invoked by an OPERATOR ACTION: a human operator,
// already authenticated by the EXISTING HQ gate, lets go of a work item they hold. The caller supplies the operator's
// identity (the `user.id` + `user.email` the HQ gate resolved) and the organisation (resolved from the SESSION, never
// from any client input) alongside the coordination being released — so the runtime never itself decides WHO the
// operator is or WHICH tenant they act for; it records the release the authenticated caller asked for.
//
// THE CLAIM ENGINE REMAINS AUTHORITATIVE — THIS RUNTIME NEVER DERIVES OWNERSHIP. It records a release AGAINST an
// already-recorded claim (by its `coordination_id`); it does not read, re-decide or assert ownership. The SECURITY
// DEFINER writer is the guard: it refuses to file a release unless the named coordination is a REAL row in the R36
// ledger THAT BELONGS TO THE RELEASING ORGANISATION, AND carries an active R46 claim in that organisation HELD BY THE
// RELEASING OPERATOR. So a release can be filed only against an item the operator's org owns and the operator holds — a
// cross-tenant release, or a release of an item held by someone else, is refused at the storage layer, and this runtime
// simply reports it (`unavailable` / `not_owned`).
//
// THE OWNERSHIP READ MODEL REMAINS AUTHORITATIVE — THIS RUNTIME READS NO OWNERSHIP. It never queries the claim ledger,
// the release ledger or the R48 read model to decide anything: it hands the request to the pure core, files one row
// through the primitive, and reports the resolution. WHETHER an item then reads as unclaimed is the R48 read model's
// derivation (a coordination is owned when it has a claim AND no release) — this runtime records the release; the read
// model reflects it.
//
// THE LEDGER ROW IS BOTH THE RELEASE RECORD AND ITS AUDIT — AND INVALID RELEASES ARE PREVENTED BY CONSTRUCTION. When the
// pure core decides `release_conversation_work`, this runtime files exactly ONE row into the append-only
// `receptionist_conversation_claim_releases` ledger through the single service-role-only SECURITY DEFINER primitive
// `record_receptionist_conversation_claim_release` — threaded to the coordination it is filed against
// (`coordination_id`, UNIQUE) and the claim it relinquishes. The primitive inserts ON CONFLICT (coordination_id) DO
// NOTHING: a repeat by the owner returns the existing id (idempotent → `released`). An attempt to release an item with
// no claim, or one held by a DIFFERENT operator, returns NULL (refused → `not_owned`). Invalid releases can never write
// a row. Ownership guarding is NOT retry: this runtime attempts the write once and lets the ledger refuse; it
// orchestrates no re-attempt.
//
// IT PERFORMS NO BUSINESS OPERATION — IT REASSIGNS, DISPATCHES, NOTIFIES, SCHEDULES, COMPLETES AND CLOSES NOTHING. It
// never reassigns work to another operator, never assigns it automatically, never dispatches it, never notifies a user,
// never schedules anything, never fulfils a quote, never promotes a customer, never completes work and never closes a
// conversation — every one is an EXPLICIT R50 non-goal. It records that a human operator has relinquished ownership,
// and nothing else follows from it here: the item simply becomes unclaimed again.
//
// IT IS BEST-EFFORT — IT NEVER THROWS. Every path is wrapped: a malformed request, a missing coordination, a
// non-owner attempt or a failed ledger write all return a `ReleaseResult` (never an exception), so a release attempt
// can never crash the operator surface that invoked it. A refused release is a normal, reported outcome (`not_owned`),
// not an error.
// =====================================================================

/**
 * The inputs {@link releaseConversationWork} needs to record a release: the organisation the release is scoped to
 * (resolved from the SESSION by the caller, never from client input), the recorded coordination being released, and the
 * authenticated operator's identity (the `user.id` + `user.email` the HQ gate resolved). The conversation and
 * correlation ids are OPTIONAL provenance threaded onto the audit row for cross-reference.
 */
export type ReleaseTrigger = {
  /** The organisation the release is scoped to — resolved from the operator's session, never from client input. */
  readonly org_id: string;
  /** The recorded R36 coordination the release is filed against. */
  readonly coordination_id: string;
  /** The authenticated operator making the release — the HQ gate's `user.id` + `user.email`. */
  readonly operator: OperatorIdentity;
  /** OPTIONAL provenance — the conversation the coordination concerns. */
  readonly conversation_id?: string | null;
  /** OPTIONAL provenance — the end-to-end trace id. */
  readonly correlation_id?: string | null;
};

/** The durable reference to a recorded release — the ledger row id, the coordination + operator it records, and its fold. */
export type RecordedRelease = {
  /** The id of the append-only `receptionist_conversation_claim_releases` row (stable across an idempotent re-release). */
  readonly release_id: string;
  /** The coordination the release is filed against. */
  readonly coordination_id: string;
  /** The operator who relinquished the claim. */
  readonly operator_id: string;
  /** The release type that was recorded. */
  readonly release_type: ReleaseType;
  /** The recorded outcome (`work_released`). */
  readonly release_outcome: ReleaseOutcome;
};

/**
 * The result of a release attempt — a discriminated union over the closed {@link ReleaseResolution} vocabulary:
 *   • `released`     — the release was recorded (or the same operator re-released their own item); carries the
 *                      {@link RecordedRelease} (with a STABLE id across an idempotent re-release). The item is returned
 *                      to the unclaimed state.
 *   • `not_owned`    — the item cannot be released by this operator (it carries no active claim, or its claim is held by
 *                      a DIFFERENT operator); nothing was written.
 *   • `unavailable`  — the release could not be recorded (ill-shaped request, the coordination does not exist in the
 *                      operator's organisation, or the ledger write failed). Best-effort — never an exception.
 */
export type ReleaseResult =
  | { readonly resolution: Extract<ReleaseResolution, "released">; readonly release: RecordedRelease }
  | { readonly resolution: Extract<ReleaseResolution, "not_owned"> }
  | { readonly resolution: Extract<ReleaseResolution, "unavailable"> };

// The write primitive is service-role-only and not in the generated Database types — cast past the typed client, the
// same `as unknown as` convention as `record_receptionist_conversation_claim` and the other ledger writers.
type RecordReleaseRpc = (
  fn: "record_receptionist_conversation_claim_release",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record an operator's RELEASE of a coordinated Conversation Worklist item — THE single entry point an operator action
 * calls, and the ONLY authorised mechanism for an operator to relinquish ownership. Hands the request to the pure
 * {@link resolveRelease} (which validates its SHAPE), and when — and only when — the pure core names a release, files
 * ONE ownership-guarded row into the append-only release ledger through the service-role-only SECURITY DEFINER
 * primitive.
 *
 * The primitive is the guard that keeps the Claim Engine authoritative and organisation isolation structural: it
 * refuses to write unless the named coordination is a REAL row in the releasing organisation that carries an active
 * claim HELD BY THE RELEASING OPERATOR. Invalid releases are prevented by that ownership gate: an item with no claim, or
 * a claim held by a different operator, returns `not_owned` and writes nothing. A repeat by the owner is idempotent
 * (`released`, stable id).
 *
 * BEST-EFFORT: every path returns a {@link ReleaseResult} and never throws — a release attempt can never crash the
 * surface that invoked it. Returns `unavailable` when the request is ill-shaped, when the coordination does not exist in
 * the operator's organisation, or when the ledger write failed; `not_owned` when the operator does not hold the item;
 * `released` (with the {@link RecordedRelease}) when the release was recorded.
 */
export async function releaseConversationWork(input: ReleaseTrigger): Promise<ReleaseResult> {
  try {
    // THE PURE DECISION — validate the SHAPE of the request. An abstention (a missing org, coordination or operator
    // identity) is reported as `unavailable`: there was nothing well-formed to record.
    const decision = resolveRelease({
      org_id: input.org_id,
      coordination_id: input.coordination_id,
      operator: input.operator,
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
    });
    if (!isReleaseDecided(decision)) return { resolution: "unavailable" };

    // RECORD the relinquish — file ONE ownership-guarded row through the service-role-only SECURITY DEFINER primitive.
    // The primitive enforces coordination authority + org isolation (the coordination must be real and in this org) and
    // the ownership gate (the coordination must carry an active claim held by THIS operator).
    const admin = createAdminClient();
    const writer = admin.rpc.bind(admin) as unknown as RecordReleaseRpc;
    const { data, error } = await writer("record_receptionist_conversation_claim_release", {
      p_org_id: decision.org_id,
      p_coordination_id: decision.coordination_id,
      p_operator_id: decision.operator.id,
      p_release_type: decision.kind,
      p_release_outcome: decision.outcome,
      p_operator_email: decision.operator.email,
      p_conversation_id: input.conversation_id ?? null,
      p_correlation_id: input.correlation_id ?? null,
      p_metadata: {},
    });

    // A raised error is the primitive's refusal — an unknown coordination, a cross-tenant attempt, or a bad
    // vocabulary. It is reported as `unavailable` (logged, never thrown): the release simply went unrecorded.
    if (error) {
      console.error("[receptionist] release write failed:", error.message);
      return { resolution: "unavailable" };
    }

    // A NULL id (with NO error) is the ownership refusal: the item carries no active claim, or its claim is held by a
    // DIFFERENT operator. Nothing was written; the attempt is reported as `not_owned`.
    if (!data) return { resolution: "not_owned" };

    // A returned id is the recorded release (or the same operator's idempotent re-release, with a stable id).
    return {
      resolution: "released",
      release: {
        release_id: data,
        coordination_id: decision.coordination_id,
        operator_id: decision.operator.id,
        release_type: decision.kind,
        release_outcome: decision.outcome,
      },
    };
  } catch (e) {
    console.error("[receptionist] conversation release threw:", e instanceof Error ? e.message : String(e));
    return { resolution: "unavailable" };
  }
}
