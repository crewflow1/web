import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { isInboxChannel, type InboxChannel } from "@/lib/inbox/channels";
import { previewBody } from "@/lib/inbox/thread";
import { normalizeAddress } from "@/lib/comms/policy";
import { toE164 } from "@/lib/phone";

/**
 * The customer's COMMUNICATIONS, as timeline events for the staff customer detail
 * page — inbound + outbound email / SMS / WhatsApp / voice (call logs) / live-chat.
 *
 * REUSE, NOT A NEW AUTHORITY. This is a pure READ over the EXISTING unified-inbox
 * pair `public.conversations` + `public.messages` (20261135000000). That pair is
 * the tenant-facing comms authority — the AI-receptionist inbound substrate
 * (`inbound_enquiries`, and thence `receptionist_conversations`) already PROJECTS
 * into it via the `inbound_enquiries_project_inbox` trigger (20261135000001), which
 * folds phone/sms/whatsapp/email/chat enquiries into these same rows. Reading the
 * unified pair therefore covers receptionist activity too, without minting a second
 * comms read path or duplicating the projected messages. Nothing here writes.
 *
 * CUSTOMER LINKAGE IS BY CONTACT IDENTITY, NOT `customer_id`. The projection and
 * the outbound composer (app/(app)/inbox/conversations/actions.ts) key a thread on
 * the NORMALISED `contact_ref` (email → bare lower-cased address; phone → E.164 /
 * lower-trimmed) and leave `conversations.customer_id` NULL. So a customer's threads
 * are resolved by matching their normalised email + phone against `contact_ref`
 * (plus any thread that DOES carry `customer_id`, for forward-compatibility).
 *
 * ORG-PINNED + LOUD + F-1 SAFE. `conversations`/`messages` are member-scoped by RLS,
 * but `current_org_ids()` admits every org the caller belongs to — so like the inbox
 * reads (server/services/inbox-conversations.ts) every query ALSO carries an explicit
 * `.eq("org_id", orgId)` active-org pin. A read error THROWS `readFailure` (never a
 * silent empty comms list). Every set-read pages via `fetchAllRows` on a stable
 * (sort, id) order so a chatty customer's history is never clipped at the 1000-row cap.
 *
 * Takes the Supabase client as an argument (the `loadCustomerFinancials` idiom) so it
 * is a pure, hermetically testable seam.
 */

export type CustomerCommsEvent = {
  /** Message id — stable identity + de-dup key. */
  id: string;
  conversationId: string;
  channel: InboxChannel;
  direction: "inbound" | "outbound";
  /** Who the message is from/to, for the "sender" column. */
  sender: string;
  /** A short single-line snippet of the body. */
  snippet: string;
  /** ISO timestamp — the sort key. */
  at: string;
  /** Whether the outbound send actually left (queued/failed while comms are dark). */
  status: string | null;
};

/** One `public.conversations` row (the columns this read needs). */
type ConversationRow = {
  id: string;
  channel: string | null;
  contact_ref: string | null;
  contact_name: string | null;
};

/** One `public.messages` row (the columns this read needs). */
type MessageRow = {
  id: string;
  conversation_id: string;
  direction: string | null;
  channel: string | null;
  from_addr: string | null;
  to_addr: string | null;
  body: string | null;
  status: string | null;
  created_at: string;
};

const CONVERSATION_COLS = "id, org_id, channel, contact_ref, contact_name, customer_id";
const MESSAGE_COLS =
  "id, conversation_id, org_id, direction, channel, from_addr, to_addr, body, status, created_at";

/**
 * The set of normalised contact identities that resolve a thread to this customer.
 * Mirrors the inbox's own `normaliseContact`: email → bare lower-cased address; phone
 * → E.164 when dial-able AND the plain lower-trimmed form the enquiry projection stores
 * (`lower(btrim(caller))`). Deterministic + deduped; empty inputs yield no ref (so a
 * customer with neither email nor phone matches nothing rather than everything). PURE.
 */
export function customerContactRefs(customer: {
  email: string | null;
  phone: string | null;
}): string[] {
  const refs = new Set<string>();
  const email = customer.email?.trim();
  if (email) {
    const norm = normalizeAddress(email);
    if (norm) refs.add(norm);
  }
  const phone = customer.phone?.trim();
  if (phone) {
    const e164 = toE164(phone);
    if (e164) refs.add(e164.toLowerCase());
    // The enquiry→inbox projection stores `lower(btrim(caller))` verbatim, which may
    // not be E.164; include it so a projected inbound call/SMS still matches.
    const plain = phone.toLowerCase();
    if (plain) refs.add(plain);
  }
  return [...refs];
}

/**
 * Shape the raw conversation + message rows into de-duplicated, reverse-chronological
 * comms events. PURE + deterministic: newest first, ties broken by the message id, so
 * the same rows always render in the same order and merge stably into the page timeline.
 */
export function buildCustomerCommsEvents(
  conversations: readonly ConversationRow[],
  messages: readonly MessageRow[],
): CustomerCommsEvent[] {
  const convById = new Map<string, ConversationRow>();
  for (const c of conversations) convById.set(c.id, c);

  const seen = new Set<string>();
  const events: CustomerCommsEvent[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const conv = convById.get(m.conversation_id);
    // A message whose conversation was not in the resolved set is not this customer's.
    if (!conv) continue;

    const channel: InboxChannel = isInboxChannel(m.channel)
      ? m.channel
      : isInboxChannel(conv.channel)
        ? conv.channel
        : "chat";
    const direction = m.direction === "outbound" ? "outbound" : "inbound";
    const sender =
      direction === "inbound"
        ? m.from_addr?.trim() ||
          conv.contact_name?.trim() ||
          conv.contact_ref?.trim() ||
          "Customer"
        : "Your team";

    events.push({
      id: m.id,
      conversationId: m.conversation_id,
      channel,
      direction,
      sender,
      snippet: previewBody(m.body),
      at: m.created_at,
      status: m.status ?? null,
    });
  }

  events.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return events;
}

/** Loose, chainable read builder — the subset of PostgREST this loader drives. */
type ReadChain<T> = {
  eq: (k: string, v: unknown) => ReadChain<T>;
  in: (k: string, v: readonly unknown[]) => ReadChain<T>;
  order: (col: string, opts: { ascending: boolean }) => ReadChain<T>;
  range: (from: number, to: number) => PromiseLike<PageResult<T>>;
};
type ReadClient = { from: (t: string) => { select: (cols: string) => ReadChain<Record<string, unknown>> } };

/**
 * Load a customer's communications as reverse-chronological timeline events.
 *
 * `orgId` MUST be the ACTIVE org (ctx.org.id) — it is the sole org-isolation boundary
 * here, pinned on every read. `customer` supplies the identity to resolve threads by.
 */
export async function loadCustomerCommsTimeline(
  supabase: SupabaseClient<Database>,
  orgId: string,
  customer: { id: string; email: string | null; phone: string | null },
): Promise<CustomerCommsEvent[]> {
  const client = supabase as unknown as ReadClient;
  const refs = customerContactRefs(customer);

  // Resolve this customer's threads two ways, both ACTIVE-org pinned:
  //   (a) any thread already carrying customer_id (forward-compatible), and
  //   (b) any thread whose normalised contact_ref matches the customer's email/phone
  //       (the path the projection + composer actually populate today).
  // Union by conversation id.
  const convById = new Map<string, ConversationRow>();

  const { data: byCustomer, error: byCustomerErr } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      client
        .from("conversations")
        .select(CONVERSATION_COLS)
        .eq("org_id", orgId)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (byCustomerErr) {
    throw readFailure("customer comms: conversations by customer", byCustomerErr as SupabaseReadError);
  }
  for (const raw of byCustomer) convById.set(String(raw.id), coerceConversation(raw));

  if (refs.length > 0) {
    const { data: byRef, error: byRefErr } = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        client
          .from("conversations")
          .select(CONVERSATION_COLS)
          .eq("org_id", orgId)
          .in("contact_ref", refs)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
    );
    if (byRefErr) {
      throw readFailure("customer comms: conversations by contact", byRefErr as SupabaseReadError);
    }
    for (const raw of byRef) convById.set(String(raw.id), coerceConversation(raw));
  }

  const conversationIds = [...convById.keys()];
  if (conversationIds.length === 0) return [];

  const { data: msgRows, error: msgErr } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      client
        .from("messages")
        .select(MESSAGE_COLS)
        .eq("org_id", orgId)
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (msgErr) throw readFailure("customer comms: messages", msgErr as SupabaseReadError);

  return buildCustomerCommsEvents([...convById.values()], msgRows.map(coerceMessage));
}

function coerceConversation(raw: Record<string, unknown>): ConversationRow {
  return {
    id: String(raw.id),
    channel: (raw.channel as string | null) ?? null,
    contact_ref: (raw.contact_ref as string | null) ?? null,
    contact_name: (raw.contact_name as string | null) ?? null,
  };
}

function coerceMessage(raw: Record<string, unknown>): MessageRow {
  return {
    id: String(raw.id),
    conversation_id: String(raw.conversation_id),
    direction: (raw.direction as string | null) ?? null,
    channel: (raw.channel as string | null) ?? null,
    from_addr: (raw.from_addr as string | null) ?? null,
    to_addr: (raw.to_addr as string | null) ?? null,
    body: (raw.body as string | null) ?? null,
    status: (raw.status as string | null) ?? null,
    created_at: String(raw.created_at),
  };
}
