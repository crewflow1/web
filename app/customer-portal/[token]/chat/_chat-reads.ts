import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Customer-portal LIVE CHAT — the shared, customer-safe read layer.
 *
 * ONE module owns "read this customer's chat" so the server page and the polling
 * endpoint cannot drift into different scoping or different projections. The
 * portal carries no Supabase JWT, so these run on the RLS-bypassing admin
 * client — which means the QUERY FILTERS are the entire security boundary, and
 * they are pinned here:
 *
 *   • The conversation is resolved by (org_id, customer_id, channel='chat') —
 *     both from the token-authenticated customer, never from client input. A
 *     customer therefore reaches exactly their OWN one chat thread and no other.
 *   • Messages are then read by (org_id, conversation_id) — the conversation id
 *     is customer-owned by the resolve above, so another customer's messages are
 *     structurally unreachable.
 *   • Rows exit ONLY through `toPortalChatMessage`, a projection with five
 *     fields. created_by, provider_id, failure_reason, to_addr, status and any
 *     future internal column are never selected and never returned — a column
 *     this layer does not read cannot leak through a later render change.
 *
 * Reads are LOUD: a query error throws (readFailure) rather than rendering as an
 * empty thread. F-1: the messages timeline is paged via fetchAllRows under the
 * PostgREST cap, ordered created_at asc then id asc for a stable total order.
 */

/** The one chat thread per customer per org: contact_ref = 'customer:<id>'. */
export function chatContactRef(customerId: string): string {
  return `customer:${customerId}`;
}

/** The CUSTOMER-SAFE message shape — the ONLY fields that leave the server. */
export type PortalChatMessage = {
  id: string;
  direction: string;
  body: string;
  created_at: string;
  auto_generated: boolean;
};

/** The raw columns this layer selects — a closed set, projected below. */
type ChatMessageRow = {
  id: string;
  direction: string;
  body: string | null;
  created_at: string;
  auto_generated: boolean | null;
};

/**
 * Project a raw row to the customer-safe shape. Explicit field-by-field copy —
 * never a spread — so an internal column added to the SELECT later cannot ride
 * out to the customer by accident.
 */
export function toPortalChatMessage(row: ChatMessageRow): PortalChatMessage {
  return {
    id: row.id,
    direction: row.direction,
    body: row.body ?? "",
    created_at: row.created_at,
    auto_generated: row.auto_generated === true,
  };
}

type AdminClient = ReturnType<typeof createAdminClient>;

type ConvResolveChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { id: string } | null;
            error: { message: string; code?: string } | null;
          }>;
        };
      };
    };
  };
};

/**
 * Resolve the customer's OWN chat conversation id, pinned to
 * (org_id, customer_id, channel='chat'). Returns null when the customer has
 * never chatted yet (no thread) — an honest empty state, distinct from a read
 * FAILURE, which throws.
 */
export async function resolveChatConversationId(
  admin: AdminClient,
  input: { orgId: string; customerId: string },
): Promise<string | null> {
  const { data, error } = await (
    admin.from("conversations" as never) as unknown as ConvResolveChain
  )
    .select("id")
    .eq("org_id", input.orgId)
    .eq("customer_id", input.customerId)
    .eq("channel", "chat")
    .maybeSingle();
  if (error) throw readFailure("portal chat: conversation resolve", error);
  return data?.id ?? null;
}

type MessagesPageChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        gt: (k: string, v: unknown) => MessagesOrdered;
        order: MessagesOrderFn;
      };
    };
  };
};
type MessagesOrdered = { order: MessagesOrderFn };
type MessagesOrderFn = (
  k: string,
  o: { ascending: boolean },
) => {
  order: (
    k: string,
    o: { ascending: boolean },
  ) => { range: (from: number, to: number) => PromiseLike<PageResult<ChatMessageRow>> };
};

/**
 * Read a customer's chat messages, customer-safe and paged.
 *
 * Scoped by (org_id, conversation_id) — the conversation id is the customer's
 * own (resolved above). `after` (an ISO timestamp) fetches only messages newer
 * than the caller's last-seen row, which is how the poll endpoint tails the
 * thread. Returns [] when the customer has no thread yet.
 */
export async function readPortalChatMessages(
  admin: AdminClient,
  input: { orgId: string; customerId: string; after?: string | null },
): Promise<PortalChatMessage[]> {
  const conversationId = await resolveChatConversationId(admin, input);
  if (!conversationId) return [];

  const { data, error } = await fetchAllRows<ChatMessageRow>((from, to) => {
    const base = (
      admin.from("messages" as never) as unknown as MessagesPageChain
    )
      .select("id, direction, body, created_at, auto_generated")
      .eq("org_id", input.orgId)
      .eq("conversation_id", conversationId);
    const ordered = input.after ? base.gt("created_at", input.after) : base;
    return ordered
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  });
  // fetchAllRows is best-effort (returns partial data + error); for a primary
  // portal read we want LOUD failure, not a silently-clipped thread.
  if (error) {
    throw readFailure("portal chat: messages", error as { message?: string; code?: string });
  }
  return data.map(toPortalChatMessage);
}
