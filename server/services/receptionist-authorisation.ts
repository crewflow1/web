import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ApproveBookingAuthorisation,
  ConversationAuthorisationType,
  AuthorisationRequirement,
  AuthorisationOpeningState,
} from "@/lib/receptionist/conversation-authorisation";

// =====================================================================
// THE CONVERSATION AUTHORISATION ENGINE — SERVER RUNTIME (CEO Directive #018, R29: CONVERSATION AUTHORISATION
// ENGINE).
//
// The pure core (lib/receptionist/conversation-authorisation.ts) RESOLVES an authorisation DECISION from the
// already-decided R28 execution decision — it folds the execution eligibility into an approval REQUIREMENT and a
// turn-time STATE, but it deliberately PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER
// RUNTIME, and it does exactly ONE thing:
//   • FILE the decision into the append-only `receptionist_conversation_authorisations` ledger through the single
//     service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_authorisation` — the
//     auditable internal record of the decision, threaded to the turn's `correlation_id` so it joins the
//     confirmation reply that announced it (and, via that shared id, the action, execution and outcome ledgers
//     too), to the very execution row it authorises (`execution_id`), and to the held reply a human resolves in
//     the EXISTING Human Review inbox (`review_audit_id`).
//
// IT RESOLVES NO ORGANISATIONAL CONSTRAINT — THERE IS NO R29 FEATURE GATE. Unlike the R28 runtime (whose
// `isBookingExecutionLive` reads a deliberate feature gate at call time), this runtime reads NO env flag and
// performs NO org lookup. The organisational constraint was ALREADY folded into the execution eligibility by R28
// (an org-disabled booking is `blocked_by_org`, which this engine maps to `foreclosed`); re-reading it here would
// duplicate that authority. The turn-time recording is gated only on a DECIDED authorisation and a present
// correlation id — exactly the inputs the pure core produced.
//
// THE LEDGER ROW IS THE EXPOSURE. Like the R27 action and R28 execution runtimes, this runtime writes exactly ONE
// internal row and STOPS — it performs NO customer write, grants no approval, promotes no lead, touches no tenant
// table. The append-only ledger row IS how the decision is EXPOSED to future business workflows: a human/CRM (or
// a later, explicitly-authorised increment) reads `receptionist_conversation_authorisations`, joins it to the
// Human Review resolution via `review_audit_id`, and acts on an approved decision.
//
// IT DETERMINES APPROVAL — IT NEVER GRANTS IT AND NEVER EXECUTES A BUSINESS ACTION. It never approves, never
// books, never writes a calendar, never schedules, never places a call, never generates a quote, never promotes a
// lead, never retries and never reconciles a receipt — every GRANT and every EXTERNAL business action is an
// explicit R29 non-goal. The `status` the ledger stores is pinned to 'assessed', and the `authorisation_state` is
// pinned to a set that OMITS any grant value ('approved'/'rejected'), so even the store is structurally incapable
// of claiming an approval was granted or an action taken. The grant itself lives ONLY in the EXISTING Human Review
// ledger (`receptionist_review_resolutions`); this runtime records the turn-time state and threads the join, it
// never records the human's decision.
//
// IT NEVER GENERATES THE CONFIRMATION, AND NEVER TOUCHES THE REPLY PIPELINE. The confirmation the customer
// receives is produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport), and
// the human's grant is recorded by the UNCHANGED Human Review architecture. This runtime reaches NO model, NO
// policy, NO enforcement seam and NO transport — it records the decision ALONGSIDE them.
//
// IT IS BEST-EFFORT — A BOOKKEEPING WRITE NEVER GATES THE TURN. Like the outcome (R26), action (R27) and
// execution (R28) writes, the write here is wrapped and swallowed on failure (logged, never thrown): a durable,
// audited confirmation reply must never be undone because a decision row could not be filed. The MANDATORY,
// throw-on-failure records remain the reply AUDIT and TRANSPORT ledgers; the authorisation ledger is a
// best-effort internal record threaded to the SAME correlation id. A failed ledger write returns null (no
// decision filed).
// =====================================================================

/**
 * The inputs {@link recordConversationAuthorisation} needs to file one authorisation decision: the organisation
 * and conversation anchors, the shared `correlation_id` (the same trace the confirmation reply is audited under),
 * the prepared action (`action_id`) and decided execution (`execution_id`) it decides over, the held reply a
 * human resolves (`review_audit_id`, the JOIN to the EXISTING Human Review inbox), and the resolved DECIDED
 * authorisation. The requirement, the turn-time state, the execution eligibility it folded and the booking
 * payload are all read from `input.decision` — the decision is self-describing, so the ledger row is fully
 * reconstructable from it.
 */
export type AuthorisationRecordInput = {
  /** The organisation the decision belongs to. */
  org_id: string;
  /** The conversation the decision was resolved on (receptionist_conversations.id). */
  conversation_id: string;
  /** The originating inbound_enquiries.id, if known. */
  enquiry_id?: string | null;
  /** The customer (leads.id), if a lead exists — carried as a durable anchor, not written to. */
  lead_id?: string | null;
  /** The caller identifier (phone / handle / email), if known. */
  customer_ref?: string | null;
  /** The end-to-end trace id — SHARED with the confirmation reply's audit, so the two join. */
  correlation_id: string;
  /** The R27 action ledger row this decision decides over, if one was filed. */
  action_id?: string | null;
  /** The R28 execution ledger row this decision authorises over, if one was filed. */
  execution_id?: string | null;
  /**
   * The held reply's `ai_reply_audits` id, when the confirmation was HELD for review (verdict='review') — the
   * JOIN to the EXISTING Human Review inbox, where a human's grant is recorded. NULL when the reply auto-sent or
   * was blocked. R29 threads it; it never writes the grant.
   */
  review_audit_id?: string | null;
  /** The resolved DECIDED authorisation decision to file (R29 ships the approve_booking decision). */
  decision: ApproveBookingAuthorisation;
  /** Free-form authorisation metadata folded onto the ledger row (the resolving path, strategy/goal, …). */
  metadata?: Record<string, unknown>;
};

/** The durable reference to a filed authorisation decision — the ledger row id, its type, requirement and state. */
export type RecordedAuthorisation = {
  /** The id of the append-only `receptionist_conversation_authorisations` row that was filed. */
  authorisation_id: string;
  /** The authorisation type that was decided. */
  authorisation_type: ConversationAuthorisationType;
  /** The resolved approval requirement. */
  requirement: AuthorisationRequirement;
  /** The turn-time authorisation state (never a grant — `pending` or `foreclosed`). */
  state: AuthorisationOpeningState;
};

// `record_receptionist_conversation_authorisation` is a service-role-only SECURITY DEFINER primitive and is not
// in the generated Database types — cast past the typed client (the same `as unknown as` convention as
// `record_receptionist_conversation_execution` and `record_receptionist_conversation_action`).
type RecordAuthorisationRpc = (
  fn: "record_receptionist_conversation_authorisation",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record ONE resolved authorisation decision — THE single entry point the conversation runtime calls when the
 * Authorisation Engine renders a decision over a decided execution. Files the decision into the append-only
 * ledger through the service-role-only SECURITY DEFINER primitive. The write is BEST-EFFORT: a failure is logged
 * and swallowed, never thrown — a durable, audited confirmation reply is never undone by a bookkeeping write.
 *
 * Returns the {@link RecordedAuthorisation} when the ledger row was filed, or null when it could not be (the
 * reply still proceeds — the decision simply went unrecorded, which is observable in the logs). The ledger row is
 * the authoritative record AND the exposure to future business workflows; there is NO grant and NO execution —
 * the decision states an approval REQUIREMENT and a turn-time state, never a performed grant. The requirement,
 * the state, the folded execution eligibility and the booking payload are all taken from `input.decision`.
 */
export async function recordConversationAuthorisation(
  input: AuthorisationRecordInput,
): Promise<RecordedAuthorisation | null> {
  const authorisationType = input.decision.kind; // the decided arm's `kind` IS its ConversationAuthorisationType
  const requirement = input.decision.requirement;
  const state = input.decision.state;
  const admin = createAdminClient();

  // FILE the auditable ledger row (best-effort). A failure means the decision went unrecorded — log and return
  // null so the caller knows, but never throw (the confirmation reply must still proceed).
  try {
    const rpc = admin.rpc.bind(admin) as unknown as RecordAuthorisationRpc;
    const { data, error } = await rpc("record_receptionist_conversation_authorisation", {
      p_org_id: input.org_id,
      p_authorisation_type: authorisationType,
      p_requirement: requirement,
      p_authorisation_state: state,
      // The eligibility, the booking payload — read straight from the decision it authorises over, so the ledger
      // row can never drift from the decision. (The pure core already folded the eligibility into the requirement
      // and state above; the DB re-validates the fold.)
      p_execution_eligibility: input.decision.execution.eligibility,
      p_correlation_id: input.correlation_id,
      p_conversation_id: input.conversation_id,
      p_enquiry_id: input.enquiry_id ?? null,
      p_lead_id: input.lead_id ?? null,
      p_customer_ref: input.customer_ref ?? null,
      p_action_id: input.action_id ?? null,
      p_execution_id: input.execution_id ?? null,
      p_review_audit_id: input.review_audit_id ?? null,
      p_job_type: input.decision.execution.action.job_type,
      p_postcode: input.decision.execution.action.postcode,
      p_phone_number: input.decision.execution.action.phone_number,
      p_metadata: input.metadata ?? {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation authorisation ledger write failed", error?.message ?? null);
      return null;
    }
    return { authorisation_id: data, authorisation_type: authorisationType, requirement, state };
  } catch (e) {
    console.error("[receptionist] conversation authorisation ledger write threw", e);
    return null;
  }
}
