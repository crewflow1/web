import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { SupportTicketRow } from "@/lib/hq/support";

/**
 * Customer-side Support service (HQ-7).
 *
 * Uses the USER-JWT supabase client so RLS scopes everything to
 * the org the customer is a member of. The HQ-side service uses
 * createAdminClient() instead and bypasses RLS.
 *
 * Internal HQ messages are filtered out automatically by the
 * support_messages RLS policy (`internal = false`).
 */

export type CustomerSupportTicket = SupportTicketRow & {
  created_by: string | null;
  resolved_at: string | null;
  closed_at: string | null;
};

export type CustomerSupportMessage = {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_kind: "customer" | "hq";
  author_name: string | null;
  body: string;
  created_at: string;
};

export type CustomerSupportTicketDetail = CustomerSupportTicket & {
  messages: ReadonlyArray<CustomerSupportMessage>;
};

// ---------------------------------------------------------------------
// List the customer's tickets (RLS-scoped to their org).
// ---------------------------------------------------------------------

export async function listMySupportTickets(): Promise<CustomerSupportTicket[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("support_tickets" as never)
    .select(
      [
        "id",
        "org_id",
        "ticket_number",
        "subject",
        "status",
        "priority",
        "category",
        "created_by",
        "last_reply_at",
        "last_reply_kind",
        "resolved_at",
        "closed_at",
        "created_at",
      ].join(", "),
    )
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[customer-support] listMySupportTickets failed", error);
    return [];
  }
  return (data ?? []).map((t: Record<string, unknown>) => ({
    id: t.id as string,
    org_id: t.org_id as string,
    org_name: null, // not surfaced on the tenant side
    ticket_number: t.ticket_number as number,
    subject: t.subject as string,
    status: t.status as string,
    priority: t.priority as string,
    category: t.category as string,
    created_by: (t.created_by as string | null) ?? null,
    last_reply_at: (t.last_reply_at as string | null) ?? null,
    last_reply_kind:
      (t.last_reply_kind as "customer" | "hq" | null) ?? null,
    resolved_at: (t.resolved_at as string | null) ?? null,
    closed_at: (t.closed_at as string | null) ?? null,
    created_at: t.created_at as string,
  }));
}

// ---------------------------------------------------------------------
// Load one ticket the customer can see (RLS handles auth).
// ---------------------------------------------------------------------

export async function loadMySupportTicket(
  ticketId: string,
): Promise<CustomerSupportTicketDetail | null> {
  const supabase = await createClient();
  const { data: t, error } = await supabase
    .from("support_tickets" as never)
    .select(
      [
        "id",
        "org_id",
        "ticket_number",
        "subject",
        "status",
        "priority",
        "category",
        "created_by",
        "last_reply_at",
        "last_reply_kind",
        "resolved_at",
        "closed_at",
        "created_at",
      ].join(", "),
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (error) {
    console.error("[customer-support] loadMySupportTicket failed", error);
    return null;
  }
  if (!t) return null;
  const ticket = t as unknown as Record<string, unknown>;

  // Fetch messages. RLS policy filters internal=true away from
  // tenant SELECTs automatically — we don't have to (and shouldn't
  // try to) replicate that filter here.
  const { data: msgs } = await supabase
    .from("support_messages" as never)
    .select(
      [
        "id",
        "ticket_id",
        "author_id",
        "author_kind",
        "body",
        "created_at",
        "author:users ( full_name )",
      ].join(", "),
    )
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  const messages: CustomerSupportMessage[] = (msgs ?? []).map(
    (m: Record<string, unknown>) => {
      const author = m.author as { full_name?: string | null } | null;
      return {
        id: m.id as string,
        ticket_id: m.ticket_id as string,
        author_id: (m.author_id as string | null) ?? null,
        author_kind: m.author_kind as "customer" | "hq",
        // For HQ replies, we don't want to leak the operator's name to
        // the customer side — show generic "CrewFlow Support" instead.
        author_name:
          m.author_kind === "hq"
            ? "CrewFlow Support"
            : (author?.full_name ?? null),
        body: m.body as string,
        created_at: m.created_at as string,
      };
    },
  );

  return {
    id: ticket.id as string,
    org_id: ticket.org_id as string,
    org_name: null,
    ticket_number: ticket.ticket_number as number,
    subject: ticket.subject as string,
    status: ticket.status as string,
    priority: ticket.priority as string,
    category: ticket.category as string,
    created_by: (ticket.created_by as string | null) ?? null,
    last_reply_at: (ticket.last_reply_at as string | null) ?? null,
    last_reply_kind:
      (ticket.last_reply_kind as "customer" | "hq" | null) ?? null,
    resolved_at: (ticket.resolved_at as string | null) ?? null,
    closed_at: (ticket.closed_at as string | null) ?? null,
    created_at: ticket.created_at as string,
    messages,
  };
}
