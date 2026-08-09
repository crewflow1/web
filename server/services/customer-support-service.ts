import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
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
  /**
   * Set when this thread is a portal conversation with one of the ORG's own
   * customers, rather than the org's helpdesk thread with CrewFlow. It is the
   * only thing distinguishing the two conversations that share these tables,
   * so every surface that attributes an author must consult it.
   */
  customer_id: string | null;
};

/**
 * Who authored a support message.
 *
 * Support OS speaks from CrewFlow's point of view, so 'customer' means THE
 * TENANT ORG and 'hq' means CrewFlow staff. The customer portal reuses these
 * tables for a second conversation — end-customer ↔ tenant — where the tenant
 * is the responder, not the customer. 'org' is that actor. See
 * supabase/migrations/20260910000000_support_messages_org_author.sql.
 */
export type SupportAuthorKind = "customer" | "hq" | "org";

export type CustomerSupportMessage = {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_kind: SupportAuthorKind;
  author_name: string | null;
  body: string;
  created_at: string;
};

export type CustomerSupportTicketDetail = CustomerSupportTicket & {
  messages: ReadonlyArray<CustomerSupportMessage>;
};

// ---------------------------------------------------------------------
// List the tickets of the ACTIVE org (RLS-gated on top).
//
// RLS is the OUTER boundary, not the scope: `current_org_ids()` returns EVERY
// org the viewer belongs to, so this used to list the other company's support
// threads — including portal conversations naming that company's customers.
// ---------------------------------------------------------------------

export async function listMySupportTickets(
  orgId: string,
): Promise<CustomerSupportTicket[]> {
  const supabase = await createClient();
  const cols = [
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
    // Distinguishes a portal conversation with the org's own customer from
    // the org's helpdesk thread with CrewFlow — the two share this table.
    "customer_id",
  ].join(", ");
  // PAGED (F-1): the ORG's full support ticket list is mapped in JS; a bare read
  // is silently clamped at max_rows=1000, so an org with a long ticket history
  // would silently lose its oldest tickets. Stable total order (created_at, id).
  // Loud read: a failed DB read must not render as "no tickets".
  const { data, error } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      (
        supabase.from("support_tickets" as never) as unknown as {
          select: (c: string) => {
            eq: (k: string, v: unknown) => {
              order: (k: string, o: { ascending: boolean }) => {
                order: (
                  k: string,
                  o: { ascending: boolean },
                ) => { range: (f: number, t: number) => PromiseLike<PageResult<Record<string, unknown>>> };
              };
            };
          };
        }
      )
        .select(cols)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("customer support: my tickets", error);
  return data.map((t: Record<string, unknown>) => ({
    id: t.id as string,
    org_id: t.org_id as string,
    org_name: null, // not surfaced on the tenant side
    customer_id: (t.customer_id as string | null) ?? null,
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
  orgId: string,
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
        // Customer-scoped threads (portal conversations) need the customer's
        // name to attribute their messages — without it the org sees its own
        // customer's words rendered as "You".
        "customer_id",
        "customer:customers ( name )",
      ].join(", "),
    )
    // ACTIVE-org read-pin (#456 read-side class). RLS here is
    // `org_id in current_org_ids()`, which admits EVERY org the viewer belongs
    // to — so a bare `.eq("id", …)` returns, for a dual-org member, the OTHER
    // org's ticket (subject + full message thread + customer name) rendered
    // under the active org's shell. Pinning `org_id` makes a foreign ticket
    // indistinguishable from a missing one, exactly like the reply action does.
    .eq("org_id", orgId)
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
  const msgCols = [
    "id",
    "ticket_id",
    "author_id",
    "author_kind",
    "body",
    "created_at",
    "author:users ( full_name )",
  ].join(", ");
  // PAGED (F-1): the full message thread for this ticket is mapped in JS; a bare
  // read is silently clamped at max_rows=1000, so a long conversation would drop
  // its newest replies. Stable total order (created_at, id). Loud read: a DB
  // error must not masquerade as an empty thread.
  const { data: msgs, error: msgsError } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      (
        supabase.from("support_messages" as never) as unknown as {
          select: (c: string) => {
            eq: (k: string, v: unknown) => {
              order: (k: string, o: { ascending: boolean }) => {
                order: (
                  k: string,
                  o: { ascending: boolean },
                ) => { range: (f: number, t: number) => PromiseLike<PageResult<Record<string, unknown>>> };
              };
            };
          };
        }
      )
        .select(msgCols)
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (msgsError) throw readFailure("customer support: ticket messages", msgsError);

  // On a portal thread, 'customer' is the END-CUSTOMER (author_id is null —
  // they have no user row), not this org. Name them from the ticket's customer
  // so their messages don't render as the org's own.
  const ticketCustomer = ticket.customer as { name?: string | null } | null;
  const isCustomerThread = ticket.customer_id != null;

  const messages: CustomerSupportMessage[] = (msgs ?? []).map(
    (m: Record<string, unknown>) => {
      const author = m.author as { full_name?: string | null } | null;
      const kind = m.author_kind as SupportAuthorKind;
      return {
        id: m.id as string,
        ticket_id: m.ticket_id as string,
        author_id: (m.author_id as string | null) ?? null,
        author_kind: kind,
        // For HQ replies, we don't want to leak the operator's name to
        // the customer side — show generic "CrewFlow Support" instead.
        author_name:
          kind === "hq"
            ? "CrewFlow Support"
            : kind === "customer" && isCustomerThread
              ? (ticketCustomer?.name ?? "Customer")
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
    customer_id: (ticket.customer_id as string | null) ?? null,
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
