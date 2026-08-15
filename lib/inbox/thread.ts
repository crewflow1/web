/**
 * P3 Inbox — thread assembly (pure).
 *
 * The deterministic shaping of a conversation's raw message rows into an ordered
 * thread plus the derived facts the UI shows (last-message preview, unread-for-operator,
 * counts). NO `server-only`, NO I/O — so it is exhaustively unit-testable and the list
 * view, the thread view and the tests share ONE ordering and ONE derivation.
 *
 * The ordering rule matches the F-1 read: created_at ASC with the row `id` as a stable
 * unique tiebreaker, so two messages minted in the same millisecond always sort the same
 * way and never swap between renders or page boundaries.
 */

import type { InboxChannel } from "./channels";

export type MessageDirection = "inbound" | "outbound";

/** One timeline entry, as read from `public.messages`. */
export type InboxMessage = {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  channel: InboxChannel | null;
  from_addr: string | null;
  to_addr: string | null;
  body: string | null;
  status: string | null;
  failure_reason: string | null;
  provider_id: string | null;
  created_by: string | null;
  created_at: string;
};

/** One thread container, as read from `public.conversations`. */
export type InboxConversation = {
  id: string;
  org_id: string;
  channel: InboxChannel;
  contact_ref: string | null;
  contact_name: string | null;
  subject: string | null;
  status: string;
  last_message_at: string | null;
  created_at: string;
};

/** Stable total order: created_at ascending, `id` as the unique tiebreaker. */
export function orderMessages(messages: readonly InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A short single-line preview of a body for the list view. */
export function previewBody(body: string | null, max = 140): string {
  if (!body) return "";
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The display name for a contact: the stored name, else the ref, else "Unknown". */
export function contactLabel(conversation: InboxConversation): string {
  return conversation.contact_name?.trim() || conversation.contact_ref?.trim() || "Unknown contact";
}

export type AssembledThread = {
  conversation: InboxConversation;
  messages: InboxMessage[];
  messageCount: number;
  lastMessage: InboxMessage | null;
  /** True when the newest message is inbound — i.e. the customer is awaiting the operator. */
  awaitingReply: boolean;
};

/**
 * Assemble a conversation and its messages into an ordered thread with the derived facts
 * the UI needs. Pure and deterministic: the same inputs always yield the same thread.
 */
export function assembleThread(
  conversation: InboxConversation,
  messages: readonly InboxMessage[],
): AssembledThread {
  const ordered = orderMessages(messages);
  const lastMessage = ordered.length > 0 ? ordered[ordered.length - 1] ?? null : null;
  return {
    conversation,
    messages: ordered,
    messageCount: ordered.length,
    lastMessage,
    awaitingReply: lastMessage?.direction === "inbound",
  };
}

/**
 * A list-view summary for one conversation: enough to render a row without fetching its
 * whole timeline. `lastPreview`/`lastDirection` come from the newest message when the
 * caller has it; when only the container is known they fall back to empty/null.
 */
export type ConversationSummary = InboxConversation & {
  lastPreview: string;
  lastDirection: MessageDirection | null;
  awaitingReply: boolean;
};

export function summariseConversation(
  conversation: InboxConversation,
  lastMessage: InboxMessage | null,
): ConversationSummary {
  return {
    ...conversation,
    lastPreview: previewBody(lastMessage?.body ?? null),
    lastDirection: lastMessage?.direction ?? null,
    awaitingReply: lastMessage?.direction === "inbound",
  };
}
