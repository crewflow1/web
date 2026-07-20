import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  PrepareBookingAction,
  ConversationActionType,
} from "@/lib/receptionist/conversation-action";

// =====================================================================
// THE CONVERSATION ACTION ENGINE — SERVER RUNTIME (CEO Directive #018, R27: CONVERSATION ACTION ENGINE).
//
// The pure core (lib/receptionist/conversation-action.ts) RESOLVES an internal action from the already-
// resolved outcome, strategy, goal and information — but it deliberately PERSISTS NOTHING and reaches NO I/O.
// This module is the engine's SERVER RUNTIME: the ONE place a resolved action is durably PREPARED. It is the
// single entry point the conversation runtime calls — {@link recordConversationAction} — and it does exactly
// ONE thing, best-effort:
//   • FILE the action into the append-only `receptionist_conversation_actions` ledger through the single
//     service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_action` — the auditable
//     internal record of the prepared action, threaded to the turn's `correlation_id` so it joins the
//     confirmation reply that announced it (and, via that shared id, the outcome ledger too).
//
// THE LEDGER ROW IS THE EXPOSURE. Unlike the R26 outcome runtime — which ALSO reflected the callback onto the
// lead's `contact_phone` — a prepared booking needs NO customer write: promoting a lead, filling a customer
// record or touching any tenant table would be preparing-toward-execution. The append-only ledger row IS how
// the action is EXPOSED to future business workflows: a human/CRM (or a later increment) reads
// `receptionist_conversation_actions` and acts on it. This runtime writes exactly that ONE internal row and
// STOPS.
//
// IT PREPARES INTERNAL ACTIONS — IT NEVER EXECUTES A BUSINESS ACTION. It never books, never writes a
// calendar, never generates a quote, never schedules, never promotes a lead to a customer, never places a
// call, and never reaches a comms provider — every EXTERNAL business action is an explicit R27 non-goal. The
// `status` the ledger stores is pinned to 'prepared' in the migration, so even the store is structurally
// incapable of claiming an external action was taken.
//
// IT NEVER GENERATES THE CONFIRMATION, AND NEVER TOUCHES THE REPLY PIPELINE. The confirmation the customer
// receives is produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport):
// a satisfied `progress_goal` turn already carries a `confirm` response objective through the Generation
// Engine, so the confirmation flows through the existing dispatch, not through here. This runtime reaches NO
// model, NO policy, NO enforcement seam and NO transport — it records the action ALONGSIDE the reply, and the
// canonical service runs the reply through the same safety pipeline it always has.
//
// IT IS BEST-EFFORT — A BOOKKEEPING WRITE NEVER GATES THE TURN. Like the outcome write (R26) and the intent /
// goal / information / runtime-state writes in the conversation runtime, the write here is wrapped and
// swallowed on failure (logged, never thrown): a durable, audited confirmation reply must never be undone
// because an action row could not be filed. The MANDATORY, throw-on-failure records remain the reply AUDIT
// and TRANSPORT ledgers; the action ledger is a best-effort internal record threaded to the SAME correlation
// id. A failed ledger write returns null (no action prepared).
// =====================================================================

/**
 * The inputs {@link recordConversationAction} needs to prepare one internal action: the organisation and the
 * conversation anchors, the shared `correlation_id` (the same trace the confirmation reply is audited under),
 * and the resolved actionable action to prepare.
 */
export type ActionRecordInput = {
  /** The organisation the action belongs to. */
  org_id: string;
  /** The conversation the action was resolved on (receptionist_conversations.id). */
  conversation_id: string;
  /** The originating inbound_enquiries.id, if known. */
  enquiry_id?: string | null;
  /** The customer (leads.id), if a lead exists — carried as a durable anchor, not written to. */
  lead_id?: string | null;
  /** The caller identifier (phone / handle / email), if known. */
  customer_ref?: string | null;
  /** The end-to-end trace id — SHARED with the confirmation reply's audit, so the two join. */
  correlation_id: string;
  /** The resolved ACTIONABLE action to prepare (R27 ships the prepare_booking action). */
  action: PrepareBookingAction;
  /** Free-form execution metadata folded onto the ledger row (the resolving path, strategy/goal, …). */
  metadata?: Record<string, unknown>;
};

/** The durable reference to a prepared action — the ledger row id and its type. */
export type RecordedAction = {
  /** The id of the append-only `receptionist_conversation_actions` row that was filed. */
  action_id: string;
  /** The action type that was prepared. */
  action_type: ConversationActionType;
};

// `record_receptionist_conversation_action` is a service-role-only SECURITY DEFINER primitive and is not in
// the generated Database types — cast past the typed client (the same `as unknown as` convention as
// `record_receptionist_conversation_outcome` and `record_ai_reply_audit`).
type RecordActionRpc = (
  fn: "record_receptionist_conversation_action",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record ONE resolved internal action — THE single entry point the conversation runtime calls when the Action
 * Engine resolves an actionable action. Files the action into the append-only ledger through the
 * service-role-only SECURITY DEFINER primitive. The write is BEST-EFFORT: a failure is logged and swallowed,
 * never thrown — a durable, audited confirmation reply is never undone by a bookkeeping write.
 *
 * Returns the {@link RecordedAction} when the ledger row was filed, or null when it could not be (the reply
 * still proceeds — the action simply went unprepared, which is observable in the logs). The ledger row is the
 * authoritative record AND the exposure to future business workflows; there is NO customer write.
 */
export async function recordConversationAction(
  input: ActionRecordInput,
): Promise<RecordedAction | null> {
  const actionType = input.action.kind; // the actionable arm's `kind` IS its ConversationActionType
  const admin = createAdminClient();

  // FILE the auditable ledger row (best-effort). A failure means the action went unprepared — log and return
  // null so the caller knows, but never throw (the confirmation reply must still proceed).
  try {
    const rpc = admin.rpc.bind(admin) as unknown as RecordActionRpc;
    const { data, error } = await rpc("record_receptionist_conversation_action", {
      p_org_id: input.org_id,
      p_action_type: actionType,
      p_correlation_id: input.correlation_id,
      p_conversation_id: input.conversation_id,
      p_enquiry_id: input.enquiry_id ?? null,
      p_lead_id: input.lead_id ?? null,
      p_customer_ref: input.customer_ref ?? null,
      p_job_type: input.action.job_type,
      p_postcode: input.action.postcode,
      p_phone_number: input.action.phone_number,
      p_metadata: input.metadata ?? {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation action ledger write failed", error?.message ?? null);
      return null;
    }
    return { action_id: data, action_type: actionType };
  } catch (e) {
    console.error("[receptionist] conversation action ledger write threw", e);
    return null;
  }
}
