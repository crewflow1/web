import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ExecuteBookingDecision,
  ConversationExecutionType,
  ExecutionEligibility,
} from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

// =====================================================================
// THE CONVERSATION EXECUTION ENGINE — SERVER RUNTIME (CEO Directive #018, R28: CONVERSATION EXECUTION ENGINE).
//
// The pure core (lib/receptionist/conversation-execution.ts) RESOLVES an execution DECISION from the already-
// prepared action, the already-computed policy verdict and the organisation's controls — but it deliberately
// PERSISTS NOTHING and reaches NO I/O. This module is the engine's SERVER RUNTIME, and it does exactly TWO
// things:
//   • RESOLVE the ORGANISATIONAL CONSTRAINT — {@link isBookingExecutionLive} reads the deliberate feature gate
//     (`NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION`, schema-validated, DEFAULT OFF) at CALL TIME, so live booking
//     execution is a genuine runtime toggle. The runtime passes this boolean INTO the pure core as the org
//     control; the pure core performs no lookup. This is the R28 analogue of R6's `isMissedCallTextbackLive`.
//   • FILE the decision into the append-only `receptionist_conversation_executions` ledger through the single
//     service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_execution` — the
//     auditable internal record of the decision, threaded to the turn's `correlation_id` so it joins the
//     confirmation reply that announced it (and, via that shared id, the action and outcome ledgers too, and
//     via `action_id` the very action row it decides over).
//
// THE LEDGER ROW IS THE EXPOSURE. Like the R27 action runtime, this runtime writes exactly ONE internal row
// and STOPS — it performs NO customer write, promotes no lead, touches no tenant table. The append-only ledger
// row IS how the decision is EXPOSED to future business workflows: a human/CRM (or a later, explicitly-
// authorised increment) reads `receptionist_conversation_executions` and acts on an eligible decision.
//
// IT DECIDES ELIGIBILITY — IT NEVER EXECUTES A BUSINESS ACTION. It never books, never writes a calendar, never
// schedules, never places a call, never generates a quote, never promotes a lead, never retries and never
// reconciles a receipt — every EXTERNAL business action is an explicit R28 non-goal. The `status` the ledger
// stores is pinned to 'decided', and the `eligibility` is pinned to a set that omits any autonomous-execute
// value, so even the store is structurally incapable of claiming an external action was taken or authorised.
//
// IT NEVER GENERATES THE CONFIRMATION, AND NEVER TOUCHES THE REPLY PIPELINE. The confirmation the customer
// receives is produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport).
// This runtime consumes the reply's ALREADY-computed policy verdict; it reaches NO model, NO policy re-run, NO
// enforcement seam and NO transport — it records the decision ALONGSIDE the reply.
//
// IT IS BEST-EFFORT — A BOOKKEEPING WRITE NEVER GATES THE TURN. Like the outcome (R26) and action (R27)
// writes, the write here is wrapped and swallowed on failure (logged, never thrown): a durable, audited
// confirmation reply must never be undone because a decision row could not be filed. The MANDATORY,
// throw-on-failure records remain the reply AUDIT and TRANSPORT ledgers; the execution ledger is a best-effort
// internal record threaded to the SAME correlation id. A failed ledger write returns null (no decision filed).
// =====================================================================

/**
 * Is CONTROLLED LIVE BOOKING EXECUTION armed for this organisation?
 *
 * The single runtime gate for R28's organisational constraint. Reads
 * `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` — schema-validated to "true" | "false" with DEFAULT "false" at boot
 * by lib/env.ts — at CALL TIME (the same convention R6's {@link isMissedCallTextbackLive} uses), so the switch
 * is a genuine runtime toggle rather than a value frozen at import. Unset or "false" ⇒ OFF ⇒ every prepared
 * booking resolves to `blocked_by_org`; only an explicit "true" lets a booking reach `requires_human_review`.
 * Even when armed, a booking NEVER executes autonomously — the strongest eligibility remains human-gated.
 */
export function isBookingExecutionLive(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION === "true";
}

/**
 * The inputs {@link recordConversationExecution} needs to file one execution decision: the organisation and
 * conversation anchors, the shared `correlation_id` (the same trace the confirmation reply is audited under),
 * the prepared action row it decides over (`action_id`), the resolved decision, and the two inputs that
 * produced its eligibility (the policy verdict and the org control) — recorded so the decision is fully
 * reconstructable from the ledger row alone.
 */
export type ExecutionRecordInput = {
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
  /** The resolved DECIDED execution decision to file (R28 ships the execute_booking decision). */
  decision: ExecuteBookingDecision;
  /** The R3 policy verdict consumed for this turn — recorded so the eligibility fold is reconstructable. */
  policy_verdict: GuardrailVerdict;
  /** Whether the org had enabled controlled live execution — the org constraint the decision folded. */
  live_execution: boolean;
  /** Free-form execution metadata folded onto the ledger row (the resolving path, strategy/goal, …). */
  metadata?: Record<string, unknown>;
};

/** The durable reference to a filed execution decision — the ledger row id, its type and its eligibility. */
export type RecordedExecution = {
  /** The id of the append-only `receptionist_conversation_executions` row that was filed. */
  execution_id: string;
  /** The execution type that was decided. */
  execution_type: ConversationExecutionType;
  /** The resolved eligibility (never an autonomous-execute value). */
  eligibility: ExecutionEligibility;
};

// `record_receptionist_conversation_execution` is a service-role-only SECURITY DEFINER primitive and is not in
// the generated Database types — cast past the typed client (the same `as unknown as` convention as
// `record_receptionist_conversation_action` and `record_receptionist_conversation_outcome`).
type RecordExecutionRpc = (
  fn: "record_receptionist_conversation_execution",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record ONE resolved execution decision — THE single entry point the conversation runtime calls when the
 * Execution Engine renders a decision over a prepared action. Files the decision into the append-only ledger
 * through the service-role-only SECURITY DEFINER primitive. The write is BEST-EFFORT: a failure is logged and
 * swallowed, never thrown — a durable, audited confirmation reply is never undone by a bookkeeping write.
 *
 * Returns the {@link RecordedExecution} when the ledger row was filed, or null when it could not be (the reply
 * still proceeds — the decision simply went unrecorded, which is observable in the logs). The ledger row is
 * the authoritative record AND the exposure to future business workflows; there is NO customer write and NO
 * execution — the decision states ELIGIBILITY, never a performed action.
 */
export async function recordConversationExecution(
  input: ExecutionRecordInput,
): Promise<RecordedExecution | null> {
  const executionType = input.decision.kind; // the decided arm's `kind` IS its ConversationExecutionType
  const eligibility = input.decision.eligibility;
  const admin = createAdminClient();

  // FILE the auditable ledger row (best-effort). A failure means the decision went unrecorded — log and return
  // null so the caller knows, but never throw (the confirmation reply must still proceed).
  try {
    const rpc = admin.rpc.bind(admin) as unknown as RecordExecutionRpc;
    const { data, error } = await rpc("record_receptionist_conversation_execution", {
      p_org_id: input.org_id,
      p_execution_type: executionType,
      p_eligibility: eligibility,
      p_policy_verdict: input.policy_verdict,
      p_live_execution: input.live_execution,
      p_correlation_id: input.correlation_id,
      p_conversation_id: input.conversation_id,
      p_enquiry_id: input.enquiry_id ?? null,
      p_lead_id: input.lead_id ?? null,
      p_customer_ref: input.customer_ref ?? null,
      p_action_id: input.action_id ?? null,
      p_job_type: input.decision.action.job_type,
      p_postcode: input.decision.action.postcode,
      p_phone_number: input.decision.action.phone_number,
      p_metadata: input.metadata ?? {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation execution ledger write failed", error?.message ?? null);
      return null;
    }
    return { execution_id: data, execution_type: executionType, eligibility };
  } catch (e) {
    console.error("[receptionist] conversation execution ledger write threw", e);
    return null;
  }
}
