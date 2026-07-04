import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { normaliseContactRef } from "@/server/services/receptionist-conversations";
import type { ConversationDirection } from "@/server/services/receptionist-conversations";
import type { InboundChannel } from "@/lib/receptionist/types";

// =====================================================================
// THE CONVERSATION TIMELINE READ MODEL (CEO Directive #018, R11).
//
// R10 laid a WRITE-ONLY substrate (receptionist_conversations + receptionist_messages) that
// THREADS a contact's messages but that nothing could READ. This module is the canonical READ
// layer over it — the SINGLE, shared, authoritative way to reconstruct a receptionist
// conversation. No feature rolls its own reconstruction logic: every consumer (an HQ view,
// channel continuity, memory retrieval, human handoff, a portal projection) reads THROUGH the
// functions here, which read THROUGH the two `security_invoker` projections shipped by
// migration 20260820000000:
//   • receptionist_conversation_timeline — one row per message, its content RESOLVED at read
//     time (inbound → inbound_enquiries.raw_text; outbound → the R9 ai_reply_lifecycle row:
//     draft + guardrail decision + transport + delivery receipt).
//   • receptionist_conversation_list     — one row per conversation: container metadata,
//     contact identity, and the last message's direction/instant.
//
// It is READ-ONLY and FOUNDATION, NOT BEHAVIOUR. It composes no reply, enforces no policy,
// contacts no provider, writes to no ledger, and mutates no substrate row — it only SELECTs
// from the two views. There is no second source of truth: message bodies are never copied,
// only referenced through the projections, which resolve them from the authoritative records.
// Every read is ORG-SCOPED (an org_id filter on every query) so tenant isolation is preserved,
// and the canonical event ORDER is defined in exactly ONE place — the pure `orderTimeline`
// below — so a conversation always reconstructs IDENTICALLY.
//
// The views are service-role-only internals (not in the generated Database types), so each
// query casts past the typed client with the same `as never` / `as unknown as` convention the
// R9 delivery surface uses to read `ai_reply_lifecycle`.
// =====================================================================

/** One row of the `receptionist_conversation_timeline` view — a single message with its
 *  authoritative content resolved. The inbound_* fields are null on an outbound entry; the
 *  outbound_*, transport_* and delivery_* fields are null on an inbound entry (and the
 *  transport_* / delivery_* fields are also null while a reply has not yet been sent). */
export type TimelineEvent = {
  message_id: string;
  conversation_id: string;
  org_id: string;
  direction: ConversationDirection;
  channel: string;
  event_at: string;
  // Inbound resolution — the customer's message (from inbound_enquiries).
  enquiry_id: string | null;
  inbound_text: string | null;
  inbound_caller: string | null;
  inbound_summary: string | null;
  inbound_job_type: string | null;
  inbound_urgency: string | null;
  inbound_postcode: string | null;
  inbound_confidence: number | null;
  inbound_status: string | null;
  inbound_at: string | null;
  // Outbound resolution — the AI reply + its enforcement decision (from ai_reply_lifecycle).
  audit_id: string | null;
  outbound_employee_slug: string | null;
  outbound_correlation_id: string | null;
  outbound_customer_ref: string | null;
  outbound_draft: string | null;
  outbound_verdict: string | null;
  outbound_allowed: boolean | null;
  outbound_categories: string[] | null;
  outbound_enforcement_reason: string | null;
  outbound_safe_text: string | null;
  outbound_audit_at: string | null;
  // Transport reference — how the reply left the building.
  transport_id: string | null;
  transport_status: string | null;
  transport_provider: string | null;
  provider_message_id: string | null;
  transport_failure_reason: string | null;
  transport_at: string | null;
  // Delivery-receipt reference — what the provider said happened to it.
  receipt_id: string | null;
  delivery_status: string | null;
  delivery_terminal: boolean | null;
  delivery_provider_status: string | null;
  delivery_error_code: string | null;
  receipt_at: string | null;
  receipt_count: number | null;
};

/** One row of the `receptionist_conversation_list` view — a conversation's container metadata,
 *  contact identity, and a preview of its most recent message. */
export type ConversationSummary = {
  conversation_id: string;
  org_id: string;
  employee_slug: string;
  channel: string;
  contact_ref: string;
  contact_name: string | null;
  status: string;
  /** The MINIMAL conversation runtime state — which party owes the next turn (R15). A coarse
   *  ownership marker the runtime advances after each turn; one of the values in
   *  lib/receptionist/runtime.ts::CONVERSATION_STATES. */
  runtime_state: string;
  /** The CONVERSATION INTENT — what the customer wants on their latest turn (R18). A per-turn
   *  classification the runtime resolves and advances; one of the values in
   *  lib/receptionist/conversation-intent.ts::CONVERSATION_INTENTS. Independent of `runtime_state`. */
  intent: string;
  /** The CONVERSATION GOAL — what the conversation is trying to accomplish (R19). A per-turn objective the
   *  runtime resolves by ELEVATING the intent, then advances; one of the values in
   *  lib/receptionist/conversation-goal.ts::CONVERSATION_GOALS. Independent of `runtime_state` AND `intent`. */
  goal: string;
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  last_direction: ConversationDirection | null;
  last_event_at: string | null;
};

/** A fully reconstructed conversation: its container metadata plus its ordered event timeline.
 *  The one object every "show me this conversation" consumer receives. */
export type ReconstructedConversation = {
  conversation: ConversationSummary;
  timeline: TimelineEvent[];
};

const TIMELINE_COLUMNS =
  "message_id, conversation_id, org_id, direction, channel, event_at, " +
  "enquiry_id, inbound_text, inbound_caller, inbound_summary, inbound_job_type, " +
  "inbound_urgency, inbound_postcode, inbound_confidence, inbound_status, inbound_at, " +
  "audit_id, outbound_employee_slug, outbound_correlation_id, outbound_customer_ref, " +
  "outbound_draft, outbound_verdict, outbound_allowed, outbound_categories, " +
  "outbound_enforcement_reason, outbound_safe_text, outbound_audit_at, " +
  "transport_id, transport_status, transport_provider, provider_message_id, " +
  "transport_failure_reason, transport_at, receipt_id, delivery_status, " +
  "delivery_terminal, delivery_provider_status, delivery_error_code, receipt_at, receipt_count";

const LIST_COLUMNS =
  "conversation_id, org_id, employee_slug, channel, contact_ref, contact_name, status, " +
  "runtime_state, intent, goal, message_count, first_message_at, last_message_at, created_at, updated_at, " +
  "last_direction, last_event_at";

// The two views are not in the generated Database types — cast past the typed client to the
// minimal chainable surface these reads use, the same convention hq-comms / the R9 delivery
// surface use. The builder is a thenable, so the interface extends PromiseLike and `await`
// yields the { data, error } envelope.
type ReadResult<Row> = { data: Row[] | null; error: { message: string } | null };
interface ReadQuery<Row> extends PromiseLike<ReadResult<Row>> {
  select(columns: string): ReadQuery<Row>;
  eq(column: string, value: string): ReadQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): ReadQuery<Row>;
  limit(count: number): ReadQuery<Row>;
}

function timelineView(): ReadQuery<TimelineEvent> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_timeline" as never,
  ) as unknown as ReadQuery<TimelineEvent>;
}

function listView(): ReadQuery<ConversationSummary> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_conversation_list" as never,
  ) as unknown as ReadQuery<ConversationSummary>;
}

/**
 * The canonical event order — the read model's ONE ordering rule, defined here so a
 * conversation reconstructs IDENTICALLY for every consumer regardless of how the database
 * returned the rows. Chronological by `event_at`, then a stable tiebreak on `message_id`
 * (a total order) so two same-instant entries never swap between reads. Pure and total: it
 * is proven directly in the unit tier, and applied to every timeline fetch below.
 */
export function compareTimelineEvents(a: TimelineEvent, b: TimelineEvent): number {
  const ta = Date.parse(a.event_at);
  const tb = Date.parse(b.event_at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.message_id !== b.message_id) return a.message_id < b.message_id ? -1 : 1;
  return 0;
}

/**
 * Return a NEW array of the events in canonical order. Non-mutating: it copies before
 * sorting, so a caller's array is never reordered under it. This is the single definition of
 * "the timeline order"; the SQL `order by` on the fetch is a consistency measure, this is the
 * authoritative projection order.
 */
export function orderTimeline(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(compareTimelineEvents);
}

/**
 * The complete, ordered timeline of one conversation — every inbound customer message and
 * every outbound AI reply, each with its authoritative content resolved (inbound text; reply
 * draft + guardrail decision + transport + delivery receipt). Org-scoped: the org_id filter is
 * mandatory, so one org can never read another's timeline. Deterministic: the rows are ordered
 * canonically by `orderTimeline`.
 */
export async function getConversationTimeline(input: {
  org_id: string;
  conversation_id: string;
}): Promise<TimelineEvent[]> {
  const { data, error } = await timelineView()
    .select(TIMELINE_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("conversation_id", input.conversation_id)
    .order("event_at", { ascending: true })
    .order("message_id", { ascending: true });
  if (error) {
    throw new Error("receptionist_conversation_timeline read failed: " + error.message);
  }
  return orderTimeline(data ?? []);
}

/**
 * The most recently active conversations for an organisation, newest first. The list index —
 * container metadata, contact identity, message counts, last activity — read from the list
 * projection. Org-scoped; capped by `limit` (default 100).
 */
export async function listConversations(input: {
  org_id: string;
  limit?: number;
}): Promise<ConversationSummary[]> {
  const limit = input.limit ?? 100;
  const { data, error } = await listView()
    .select(LIST_COLUMNS)
    .eq("org_id", input.org_id)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error("receptionist_conversation_list read failed: " + error.message);
  }
  return data ?? [];
}

/**
 * One conversation's metadata by id (contact identity, status, message_count, first/last
 * activity, last-message preview), or null if it does not exist in this organisation.
 * Org-scoped, so a caller can only ever resolve a conversation that belongs to it.
 */
export async function getConversation(input: {
  org_id: string;
  conversation_id: string;
}): Promise<ConversationSummary | null> {
  const { data, error } = await listView()
    .select(LIST_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("conversation_id", input.conversation_id)
    .limit(1);
  if (error) {
    throw new Error("receptionist_conversation_list read failed: " + error.message);
  }
  return data?.[0] ?? null;
}

/**
 * The conversation a contact belongs to on a channel, or null. Reuses the SAME contact-identity
 * rule as the write path (`normaliseContactRef` — trim + casefold), so a contact resolves to the
 * SAME conversation on read as it was threaded onto on write, with no drift. An empty identifier
 * short-circuits to null (no contact ⇒ no conversation) before any query, mirroring the writer.
 * Org- and channel-scoped, matching the substrate's unique (org_id, channel, contact_ref) key.
 */
export async function getConversationByContact(input: {
  org_id: string;
  channel: InboundChannel;
  contact_ref: string | null | undefined;
}): Promise<ConversationSummary | null> {
  const contact = normaliseContactRef(input.contact_ref);
  if (!contact) return null; // no contact identifier ⇒ no conversation to resolve
  const { data, error } = await listView()
    .select(LIST_COLUMNS)
    .eq("org_id", input.org_id)
    .eq("channel", input.channel)
    .eq("contact_ref", contact)
    .limit(1);
  if (error) {
    throw new Error("receptionist_conversation_list read failed: " + error.message);
  }
  return data?.[0] ?? null;
}

/**
 * Reconstruct a complete conversation — its container metadata AND its ordered timeline — in
 * one call. THE canonical "show me this conversation" entry point: every consumer that needs a
 * full conversation history uses this, so the reconstruction lives in exactly one place.
 * Returns null when the conversation does not exist in this organisation.
 */
export async function reconstructConversation(input: {
  org_id: string;
  conversation_id: string;
}): Promise<ReconstructedConversation | null> {
  const conversation = await getConversation(input);
  if (!conversation) return null;
  const timeline = await getConversationTimeline(input);
  return { conversation, timeline };
}
