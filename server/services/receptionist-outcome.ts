import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  CallbackOutcome,
  ConversationOutcomeType,
} from "@/lib/receptionist/conversation-outcome";

// =====================================================================
// THE CONVERSATION OUTCOME ENGINE — SERVER RUNTIME (CEO Directive #018, R26: CONVERSATION OUTCOME ENGINE).
//
// The pure core (lib/receptionist/conversation-outcome.ts) RESOLVES an internal outcome from the already-
// derived strategy, goal and information — but it deliberately PERSISTS NOTHING and reaches NO I/O. This
// module is the engine's SERVER RUNTIME: the ONE place a resolved outcome is durably RECORDED. It is the
// single entry point the conversation runtime calls — {@link recordConversationOutcome} — and it does
// exactly two things, BOTH best-effort:
//   1. FILE the outcome into the append-only `receptionist_conversation_outcomes` ledger through the single
//      service-role-only SECURITY DEFINER primitive `record_receptionist_conversation_outcome` — the
//      auditable internal record of the outcome, threaded to the turn's `correlation_id` so it joins the
//      confirmation reply that announced it.
//   2. REFLECT the outcome onto the CUSTOMER using EXISTING lead fields — for a callback, fill the lead's
//      `contact_phone` (fill-if-empty, org-scoped) so the team knows the number to ring. The ledger row is
//      the authoritative outcome record; the lead write is a convenience reflection.
//
// IT RECORDS INTERNAL OUTCOMES — IT NEVER EXECUTES A BUSINESS ACTION. It writes exactly the two internal
// rows above and STOPS. It never books, never schedules, never prices, never promotes a lead to a customer,
// never places a call, and never reaches a comms provider — every EXTERNAL business action is an explicit
// R26 non-goal. The `status` the ledger stores is pinned to 'recorded' in the migration, so even the store
// is structurally incapable of claiming an external action was taken.
//
// IT NEVER GENERATES THE CONFIRMATION, AND NEVER TOUCHES THE REPLY PIPELINE. The confirmation the customer
// receives is produced and audited by the UNCHANGED reply pipeline (Generate → Enforce → Audit → Transport):
// a satisfied `progress_goal` turn already carries a `confirm` response objective through the Generation
// Engine, so the confirmation flows through the existing dispatch, not through here. This runtime reaches NO
// model, NO policy, NO enforcement seam and NO transport — it records the outcome ALONGSIDE the reply, and
// the canonical service runs the reply through the same safety pipeline it always has.
//
// IT IS BEST-EFFORT — A BOOKKEEPING WRITE NEVER GATES THE TURN. Like the intent / goal / information /
// runtime-state writes in the conversation runtime, both writes here are wrapped and swallowed on failure
// (logged, never thrown): a durable, audited confirmation reply must never be undone because an outcome row
// could not be filed. The MANDATORY, throw-on-failure records remain the reply AUDIT and TRANSPORT ledgers;
// the outcome ledger is a best-effort internal record threaded to the SAME correlation id. A failed ledger
// write returns null (no outcome recorded); a failed lead reflection is swallowed but does not fail the
// outcome (the ledger row is already the authoritative record).
// =====================================================================

/**
 * The inputs {@link recordConversationOutcome} needs to file one internal outcome: the organisation and the
 * conversation anchors, the shared `correlation_id` (the same trace the confirmation reply is audited under),
 * and the resolved actionable outcome to record.
 */
export type OutcomeRecordInput = {
  /** The organisation the outcome belongs to. */
  org_id: string;
  /** The conversation the outcome was resolved on (receptionist_conversations.id). */
  conversation_id: string;
  /** The originating inbound_enquiries.id, if known. */
  enquiry_id?: string | null;
  /** The customer (leads.id), if a lead exists — the row the callback is reflected onto. */
  lead_id?: string | null;
  /** The caller identifier (phone / handle / email), if known. */
  customer_ref?: string | null;
  /** The end-to-end trace id — SHARED with the confirmation reply's audit, so the two join. */
  correlation_id: string;
  /** The resolved ACTIONABLE outcome to record (R26 ships the callback outcome). */
  outcome: CallbackOutcome;
  /** Free-form execution metadata folded onto the ledger row (the resolving path, strategy/goal, …). */
  metadata?: Record<string, unknown>;
};

/** The durable reference to a recorded outcome — the ledger row id and its type. */
export type RecordedOutcome = {
  /** The id of the append-only `receptionist_conversation_outcomes` row that was filed. */
  outcome_id: string;
  /** The outcome type that was recorded. */
  outcome_type: ConversationOutcomeType;
};

// `record_receptionist_conversation_outcome` is a service-role-only SECURITY DEFINER primitive and is not in
// the generated Database types — cast past the typed client (the same `as unknown as` convention as
// `record_ai_reply_audit`).
type RecordOutcomeRpc = (
  fn: "record_receptionist_conversation_outcome",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Record ONE resolved internal outcome — THE single entry point the conversation runtime calls when the
 * Outcome Engine resolves an actionable outcome. Files the outcome into the append-only ledger through the
 * service-role-only SECURITY DEFINER primitive, then REFLECTS it onto the customer's lead using existing
 * fields. BOTH steps are BEST-EFFORT: a failure is logged and swallowed, never thrown — a durable, audited
 * confirmation reply is never undone by a bookkeeping write.
 *
 * Returns the {@link RecordedOutcome} when the ledger row was filed, or null when it could not be (the reply
 * still proceeds — the outcome simply went unrecorded, which is observable in the logs). The lead reflection
 * is secondary: it runs only after a successful ledger write and only when a lead exists; its failure does
 * not fail the outcome (the ledger row is already the authoritative record).
 */
export async function recordConversationOutcome(
  input: OutcomeRecordInput,
): Promise<RecordedOutcome | null> {
  const outcomeType = input.outcome.kind; // the actionable arm's `kind` IS its ConversationOutcomeType
  const admin = createAdminClient();

  // 1. FILE the auditable ledger row (best-effort). A failure means the outcome went unrecorded — log and
  //    return null so the caller knows, but never throw (the confirmation reply must still proceed).
  let outcomeId: string;
  try {
    const rpc = admin.rpc.bind(admin) as unknown as RecordOutcomeRpc;
    const { data, error } = await rpc("record_receptionist_conversation_outcome", {
      p_org_id: input.org_id,
      p_outcome_type: outcomeType,
      p_correlation_id: input.correlation_id,
      p_conversation_id: input.conversation_id,
      p_enquiry_id: input.enquiry_id ?? null,
      p_lead_id: input.lead_id ?? null,
      p_customer_ref: input.customer_ref ?? null,
      p_phone_number: input.outcome.phone_number,
      p_metadata: input.metadata ?? {},
    });
    if (error || !data) {
      console.error("[receptionist] conversation outcome ledger write failed", error?.message ?? null);
      return null;
    }
    outcomeId = data;
  } catch (e) {
    console.error("[receptionist] conversation outcome ledger write threw", e);
    return null;
  }

  // 2. REFLECT the callback onto the lead (best-effort, secondary). Fill-if-empty and ORG-SCOPED: set
  //    `contact_phone` only when it is currently null (never clobber an existing CRM value — the ledger row
  //    always holds the authoritative callback number), and only on a row in this org. A failure is
  //    swallowed: the outcome is already recorded.
  if (input.lead_id) {
    try {
      // `contact_phone` landed in migration 20260601000100_leads_contact_fields and is not yet in the
      // generated Supabase types — the `as never` casts keep the typed client happy (the established house
      // pattern; cf. app/(app)/leads/actions.ts) until the types are regenerated.
      const { error } = await admin
        .from("leads")
        .update({ contact_phone: input.outcome.phone_number } as never)
        .eq("id", input.lead_id)
        .eq("org_id", input.org_id)
        .is("contact_phone" as never, null);
      if (error) {
        console.error("[receptionist] callback lead reflection failed", error.message);
      }
    } catch (e) {
      console.error("[receptionist] callback lead reflection threw", e);
    }
  }

  return { outcome_id: outcomeId, outcome_type: outcomeType };
}
