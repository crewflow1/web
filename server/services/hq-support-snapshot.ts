import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupportTicketRow } from "@/lib/hq/support";

/**
 * CrewFlow HQ — Support OS aggregator (HQ-7).
 *
 * Service-role only — callers MUST have confirmed isSuperAdminEmail.
 * Reads cross-tenant by design.
 *
 * Two queries (no N+1):
 *   1. support_tickets joined to organizations (name lookup)
 *   2. support_messages for a specific ticket (detail view only)
 */

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
  limit: (n: number) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
};

function adminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
  };
}

// ---------------------------------------------------------------------
// HQ-side row shapes
// ---------------------------------------------------------------------

export type HqSupportTicketRow = SupportTicketRow & {
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  /** Latest reply preview — first 200 chars of the most recent
   * non-internal message body, joined-in by the list query. */
  last_reply_preview: string | null;
  /** Whether the most recent message is internal-only. */
  has_internal_notes: boolean;
};

export type HqSupportMessage = {
  id: string;
  ticket_id: string;
  org_id: string;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  author_kind: "customer" | "hq";
  internal: boolean;
  body: string;
  created_at: string;
};

export type HqSupportTicketDetail = HqSupportTicketRow & {
  messages: ReadonlyArray<HqSupportMessage>;
  /** Org metadata for the side panel. */
  org_status: string | null;
  org_email: string | null;
  org_phone: string | null;
  /** Owner contact resolved through memberships. */
  owner_name: string | null;
  owner_email: string | null;
};

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------

export async function listSupportTicketsForHq(): Promise<HqSupportTicketRow[]> {
  // 1. Pull every ticket joined with org name.
  const res = await adminTable("support_tickets")
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
        "assigned_to",
        "last_reply_at",
        "last_reply_kind",
        "resolved_at",
        "closed_at",
        "created_at",
        "updated_at",
        "org:organizations ( name )",
      ].join(", "),
    )
    .order("created_at", { ascending: false });
  const tickets = (res.data ?? []) as unknown as Array<{
    id: string;
    org_id: string;
    ticket_number: number;
    subject: string;
    status: string;
    priority: string;
    category: string;
    created_by: string | null;
    assigned_to: string | null;
    last_reply_at: string | null;
    last_reply_kind: "customer" | "hq" | null;
    resolved_at: string | null;
    closed_at: string | null;
    created_at: string;
    updated_at: string | null;
    org: { name: string | null } | null;
  }>;

  if (tickets.length === 0) return [];

  // 2. Fetch all messages for these tickets in ONE batched query so
  //    we can compute "last reply preview" + "has internal notes"
  //    per ticket without N+1.
  const ticketIds = tickets.map((t) => t.id);
  const msgRes = await adminTable("support_messages")
    .select("id, ticket_id, body, internal, created_at")
    .in("ticket_id", ticketIds)
    .order("created_at", { ascending: false });
  const messages = (msgRes.data ?? []) as unknown as Array<{
    id: string;
    ticket_id: string;
    body: string;
    internal: boolean;
    created_at: string;
  }>;

  const lastByTicket = new Map<
    string,
    { body: string; internal: boolean }
  >();
  const hasInternalByTicket = new Map<string, boolean>();
  // messages are ordered newest-first → the first one we see per
  // ticket is the latest, but we want the latest NON-internal one
  // for the preview. Track both.
  for (const m of messages) {
    if (!lastByTicket.has(m.ticket_id) && !m.internal) {
      lastByTicket.set(m.ticket_id, { body: m.body, internal: false });
    }
    if (m.internal) hasInternalByTicket.set(m.ticket_id, true);
  }

  return tickets.map((t) => ({
    id: t.id,
    org_id: t.org_id,
    org_name: t.org?.name ?? null,
    ticket_number: t.ticket_number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    created_by: t.created_by,
    assigned_to: t.assigned_to,
    last_reply_at: t.last_reply_at,
    last_reply_kind: t.last_reply_kind,
    resolved_at: t.resolved_at,
    closed_at: t.closed_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_reply_preview:
      lastByTicket.get(t.id)?.body?.slice(0, 200) ?? null,
    has_internal_notes: hasInternalByTicket.get(t.id) ?? false,
  }));
}

// ---------------------------------------------------------------------
// Lean board reader — ticket rows ONLY, no message join.
// ---------------------------------------------------------------------

/**
 * The minimal ticket columns the deterministic triage board needs. No org
 * name, no message preview, no internal-notes flag.
 */
export type HqSupportBoardRow = {
  status: string;
  priority: string;
  category: string;
  created_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  last_reply_at: string | null;
  last_reply_kind: "customer" | "hq" | null;
};

/**
 * Fetch just the ticket columns the triage board triages over. Unlike
 * `listSupportTicketsForHq` (which additionally batch-fetches every message
 * body across all tickets to build the list-UI preview + internal-notes flag),
 * this reads the tickets table alone — the board never touches message bodies,
 * so it should not pull them cross-tenant. Loud-read/degrade: on a read error
 * `res.data` is null and we return `[]`, exactly like the other HQ readers.
 */
export async function listSupportTicketRowsForHq(): Promise<HqSupportBoardRow[]> {
  const res = await adminTable("support_tickets")
    .select(
      [
        "status",
        "priority",
        "category",
        "last_reply_at",
        "last_reply_kind",
        "resolved_at",
        "closed_at",
        "created_at",
      ].join(", "),
    )
    .order("created_at", { ascending: false });
  return (res.data ?? []) as unknown as HqSupportBoardRow[];
}

// ---------------------------------------------------------------------
// Detail (single ticket + full message thread)
// ---------------------------------------------------------------------

export async function loadSupportTicketDetailForHq(
  ticketId: string,
): Promise<HqSupportTicketDetail | null> {
  // 1. Ticket + org join.
  const tRes = await adminTable("support_tickets")
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
        "assigned_to",
        "last_reply_at",
        "last_reply_kind",
        "resolved_at",
        "closed_at",
        "created_at",
        "updated_at",
        "org:organizations ( name, status, email, phone )",
      ].join(", "),
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (!tRes.data) return null;
  const t = tRes.data as unknown as {
    id: string;
    org_id: string;
    ticket_number: number;
    subject: string;
    status: string;
    priority: string;
    category: string;
    created_by: string | null;
    assigned_to: string | null;
    last_reply_at: string | null;
    last_reply_kind: "customer" | "hq" | null;
    resolved_at: string | null;
    closed_at: string | null;
    created_at: string;
    updated_at: string | null;
    org: {
      name: string | null;
      status: string | null;
      email: string | null;
      phone: string | null;
    } | null;
  };

  // 2. Owner (best-effort via memberships → users join).
  const admin = createAdminClient();
  const { data: ownerRow } = await admin
    .from("memberships")
    .select("user:users ( full_name, email )")
    .eq("org_id", t.org_id)
    .eq("role", "owner")
    .maybeSingle();
  const owner = ownerRow as unknown as {
    user?: { full_name?: string | null; email?: string | null } | null;
  } | null;

  // 3. Full message thread (INCLUDING internal — HQ sees everything).
  const mRes = await adminTable("support_messages")
    .select(
      [
        "id",
        "ticket_id",
        "org_id",
        "author_id",
        "author_kind",
        "internal",
        "body",
        "created_at",
        "author:users ( full_name, email )",
      ].join(", "),
    )
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  const messagesRaw = (mRes.data ?? []) as unknown as Array<{
    id: string;
    ticket_id: string;
    org_id: string;
    author_id: string | null;
    author_kind: "customer" | "hq";
    internal: boolean;
    body: string;
    created_at: string;
    author: { full_name?: string | null; email?: string | null } | null;
  }>;
  const messages: HqSupportMessage[] = messagesRaw.map((m) => ({
    id: m.id,
    ticket_id: m.ticket_id,
    org_id: m.org_id,
    author_id: m.author_id,
    author_name: m.author?.full_name ?? null,
    author_email: m.author?.email ?? null,
    author_kind: m.author_kind,
    internal: m.internal,
    body: m.body,
    created_at: m.created_at,
  }));

  return {
    id: t.id,
    org_id: t.org_id,
    org_name: t.org?.name ?? null,
    ticket_number: t.ticket_number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    created_by: t.created_by,
    assigned_to: t.assigned_to,
    last_reply_at: t.last_reply_at,
    last_reply_kind: t.last_reply_kind,
    resolved_at: t.resolved_at,
    closed_at: t.closed_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_reply_preview:
      messages
        .filter((m) => !m.internal)
        .slice(-1)[0]
        ?.body.slice(0, 200) ?? null,
    has_internal_notes: messages.some((m) => m.internal),
    messages,
    org_status: t.org?.status ?? null,
    org_email: t.org?.email ?? null,
    org_phone: t.org?.phone ?? null,
    owner_name: owner?.user?.full_name ?? null,
    owner_email: owner?.user?.email ?? null,
  };
}

// ---------------------------------------------------------------------
// Open-ticket count (drives HQ_NAV badge)
// ---------------------------------------------------------------------

export async function countOpenSupportTicketsForHq(): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("support_tickets" as never)
    .select("id" as never, { count: "exact", head: true })
    .in("status" as never, ["open", "in_progress", "waiting_on_customer"]);
  if (error) {
    console.error("[hq-support] countOpenSupportTicketsForHq failed", error);
    return 0;
  }
  return count ?? 0;
}
