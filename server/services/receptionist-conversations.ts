import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { RECEPTIONIST_EMPLOYEE_SLUG } from "@/lib/receptionist/types";
import type { InboundChannel } from "@/lib/receptionist/types";

// =====================================================================
// THE CONVERSATION & CONTACT-IDENTITY SUBSTRATE (CEO Directive #018, R10).
//
// R1–R9 shipped a STATELESS, single-shot responder: every inbound message became an
// isolated `inbound_enquiries` row with no container grouping a contact's messages and
// no durable contact identity. R10 lays the missing substrate — a persistent, org-scoped
// CONVERSATION keyed by a resolved contact identity, plus a threaded MESSAGE timeline —
// as shared infrastructure BENEATH the canonical pipeline.
//
// This module is the read/write service for that substrate. It is FOUNDATION, NOT
// BEHAVIOUR: it composes no reply, enforces no policy, contacts no provider, and opens no
// outbound path. It threads the EXISTING single-shot flow onto persistent conversations.
// The two writers are the service-role-only SECURITY DEFINER primitives
// `resolve_receptionist_conversation` (the atomic, race-safe contact-identity resolver)
// and `append_receptionist_message` (the threading write) — the same
// service-role-only + cast-past-the-generated-types convention the reply ledger writers
// (`record_ai_reply_*`) use, because these functions are not in the generated Database
// types.
// =====================================================================

// The substrate RPCs are service-role-only SECURITY DEFINER primitives and are not in the
// generated Database types — cast past the typed client, the same `as unknown as`
// convention as `record_ai_reply_audit` / `record_ai_reply_transport`.
type ResolveConversationRpc = (
  fn: "resolve_receptionist_conversation",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;
type AppendMessageRpc = (
  fn: "append_receptionist_message",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** A message's place in the conversation timeline. */
export type ConversationDirection = "inbound" | "outbound";

/**
 * Normalise a contact identifier the SAME way the database resolver does (trim + casefold),
 * so the SAME person on the SAME channel always folds to ONE conversation. Kept as a pure,
 * exported helper: the TypeScript side short-circuits an empty identifier BEFORE any RPC (no
 * contact ⇒ no conversation), and the identical rule lives in
 * `resolve_receptionist_conversation` so the resolved identity can never drift between the
 * two. Returns "" when there is no usable identifier.
 */
export function normaliseContactRef(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/** True when an inbound event carries a contact we can thread a conversation on. */
export function hasResolvableContact(raw: string | null | undefined): boolean {
  return normaliseContactRef(raw) !== "";
}

/**
 * Resolve (or create) the persistent CONVERSATION a contact belongs to, and return its id.
 *
 * A repeat contact on the same channel resolves to the SAME conversation; a new contact — or
 * the same identifier in another organisation, or on another channel — gets its own. The
 * resolution is a single atomic INSERT ... ON CONFLICT in the database, so it is race-safe
 * under concurrent inbound. An absent identifier is NOT an error — it returns `null` (nothing
 * to thread), short-circuited here before the RPC. A genuine database failure THROWS, so the
 * caller (which treats the substrate as best-effort) can log and continue without disturbing
 * the durable ingestion contract.
 */
export async function resolveConversation(input: {
  org_id: string;
  channel: InboundChannel;
  contact_ref: string | null | undefined;
  contact_name?: string | null;
}): Promise<string | null> {
  const contact = normaliseContactRef(input.contact_ref);
  if (!contact) return null; // no contact identifier ⇒ no conversation to resolve

  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as ResolveConversationRpc;
  const { data, error } = await rpc("resolve_receptionist_conversation", {
    p_org_id: input.org_id,
    p_employee_slug: RECEPTIONIST_EMPLOYEE_SLUG,
    p_channel: input.channel,
    p_contact_ref: contact,
    p_contact_name: input.contact_name ?? null,
  });
  if (error || !data) {
    throw new Error(
      "resolve_receptionist_conversation failed: " + (error?.message ?? "no conversation id returned"),
    );
  }
  return data;
}

/**
 * Append ONE entry to a conversation's message timeline and advance its counters.
 *
 * The entry does NOT copy message content — it REFERENCES its authoritative source, so the
 * substrate keeps exactly one source of truth: an inbound entry carries `enquiry_id` (the
 * `inbound_enquiries` row whose raw_text IS the content); an outbound entry carries
 * `audit_id` (the `ai_reply_audits` row whose draft IS the content). Delegates to the
 * service-role-only `append_receptionist_message` primitive, which validates direction,
 * inserts the entry, and bumps `message_count` / `last_message_at` on the container. Returns
 * the new message id; a database failure THROWS for the caller's best-effort handling.
 */
export async function appendConversationMessage(input: {
  conversation_id: string;
  org_id: string;
  direction: ConversationDirection;
  channel: InboundChannel;
  enquiry_id?: string | null;
  audit_id?: string | null;
}): Promise<string> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as AppendMessageRpc;
  const { data, error } = await rpc("append_receptionist_message", {
    p_conversation_id: input.conversation_id,
    p_org_id: input.org_id,
    p_direction: input.direction,
    p_channel: input.channel,
    p_enquiry_id: input.enquiry_id ?? null,
    p_audit_id: input.audit_id ?? null,
  });
  if (error || !data) {
    throw new Error(
      "append_receptionist_message failed: " + (error?.message ?? "no message id returned"),
    );
  }
  return data;
}
