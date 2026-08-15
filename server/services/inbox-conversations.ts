import "server-only";

/**
 * P3 Inbox — the tenant-facing conversation reads (list + thread).
 *
 * Every read here is:
 *   - RLS-gated (the user-JWT client) AND additionally ACTIVE-ORG PINNED with an explicit
 *     `.eq("org_id", orgId)` — because `current_org_ids()` admits every org the caller
 *     belongs to, so RLS alone would let a dual-org member read another of their orgs'
 *     threads under the active shell;
 *   - LOUD — a query error THROWS `readFailure` so a failed read can never render as an
 *     empty inbox (the silent-empty-state class);
 *   - F-1 SAFE — list reads page through `fetchAllRows` with a `.range()` window and a
 *     stable (sort, id) ordering, so nothing is silently truncated at the PostgREST cap.
 *
 * The `conversations`/`messages` tables carry columns added after the generated types were
 * last regenerated (contact_ref, subject, status, channel, failure_reason, created_by), so
 * the query builder is reached through narrow `as unknown as` shims — the same casting
 * convention app/(app)/inbox/page.tsx and server/services/receptionist.ts already use.
 */

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  assembleThread,
  summariseConversation,
  type AssembledThread,
  type ConversationSummary,
  type InboxConversation,
  type InboxMessage,
} from "@/lib/inbox/thread";
import { isInboxChannel, type InboxChannel } from "@/lib/inbox/channels";

const CONVERSATION_COLS =
  "id, org_id, channel, contact_ref, contact_name, subject, status, last_message_at, created_at";
const MESSAGE_COLS =
  "id, conversation_id, org_id, direction, channel, from_addr, to_addr, body, status, failure_reason, provider_id, created_by, created_at";

type Row = Record<string, unknown>;

/** A loose, chainable read builder — any run of eq/order then a terminal range or maybeSingle. */
type ReadChain = {
  eq: (k: string, v: unknown) => ReadChain;
  order: (col: string, opts: { ascending: boolean }) => ReadChain;
  range: (
    from: number,
    to: number,
  ) => Promise<{ data: Row[] | null; error: SupabaseReadError | null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: SupabaseReadError | null }>;
};
type ReadClient = { from: (t: string) => { select: (cols: string) => ReadChain } };

function coerceConversation(row: Row): InboxConversation {
  const channel = row.channel;
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    channel: (isInboxChannel(channel) ? channel : "chat") as InboxChannel,
    contact_ref: (row.contact_ref as string | null) ?? null,
    contact_name: (row.contact_name as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    status: (row.status as string | null) ?? "active",
    last_message_at: (row.last_message_at as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

function coerceMessage(row: Row): InboxMessage {
  const channel = row.channel;
  const direction = row.direction === "outbound" ? "outbound" : "inbound";
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    direction,
    channel: (isInboxChannel(channel) ? channel : null) as InboxChannel | null,
    from_addr: (row.from_addr as string | null) ?? null,
    to_addr: (row.to_addr as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    failure_reason: (row.failure_reason as string | null) ?? null,
    provider_id: (row.provider_id as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

/**
 * List an org's conversations, newest activity first, with a last-message preview and the
 * awaiting-reply flag. F-1 safe: both the conversation read and the message read page via
 * `fetchAllRows`. The latest message per conversation is derived from a single org-pinned,
 * created_at-DESC message read (first-seen per conversation_id = latest) — the codebase's
 * documented "read all, aggregate in TS" posture at the launch horizon.
 */
export async function listInboxConversations(orgId: string): Promise<ConversationSummary[]> {
  const supabase = (await createClient()) as unknown as ReadClient;

  const { data: convRows, error: convErr } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("conversations")
      .select(CONVERSATION_COLS)
      .eq("org_id", orgId)
      .order("last_message_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (convErr) throw readFailure("inbox: conversation list", convErr as SupabaseReadError);

  const { data: msgRows, error: msgErr } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("messages")
      .select(MESSAGE_COLS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (msgErr) throw readFailure("inbox: conversation previews", msgErr as SupabaseReadError);

  // First-seen per conversation_id under created_at DESC ⇒ the latest message.
  const latestByConversation = new Map<string, InboxMessage>();
  for (const raw of msgRows) {
    const m = coerceMessage(raw);
    if (!latestByConversation.has(m.conversation_id)) {
      latestByConversation.set(m.conversation_id, m);
    }
  }

  return convRows.map((raw) => {
    const conversation = coerceConversation(raw);
    return summariseConversation(conversation, latestByConversation.get(conversation.id) ?? null);
  });
}

/**
 * Load one conversation and its full, ordered timeline, or `null` when it does not exist
 * in the active org (a foreign or missing thread is indistinguishable — the fail-closed
 * active-org pin). Loud: a query error throws; only a genuinely-absent row returns null.
 */
export async function loadInboxThread(
  orgId: string,
  conversationId: string,
): Promise<AssembledThread | null> {
  const supabase = (await createClient()) as unknown as ReadClient;

  const { data: convRow, error: convErr } = await supabase
    .from("conversations")
    .select(CONVERSATION_COLS)
    .eq("id", conversationId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (convErr) throw readFailure("inbox: thread container", convErr);
  if (!convRow) return null;

  const { data: msgRows, error: msgErr } = await fetchAllRows<Row>((from, to) =>
    supabase
      .from("messages")
      .select(MESSAGE_COLS)
      .eq("org_id", orgId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (msgErr) throw readFailure("inbox: thread messages", msgErr as SupabaseReadError);

  return assembleThread(coerceConversation(convRow), msgRows.map(coerceMessage));
}
