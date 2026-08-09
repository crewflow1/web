import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { SupportTicketRow } from "@/lib/hq/support";

/**
 * CrewFlow HQ — Support OS aggregator (HQ-7).
 *
 * Service-role only — callers MUST have confirmed isSuperAdminEmail.
 * Reads cross-tenant by design.
 *
 * F-1 COMPLETENESS. Every list read here is CROSS-TENANT (service-role, no
 * `org_id` pin) and its full row set is then mapped / counted in JS to produce
 * figures the pure board/demand layers label "fact". PostgREST clamps every
 * response at `max_rows=1000` (supabase/config.toml) — the service-role path is
 * NOT exempt — so a bare `.select().order()` silently truncates to the first
 * 1000 rows once the cumulative cross-tenant volume crosses that line, and the
 * board/demand figures under-report with no error. So every set read pages via
 * `fetchAllRows` on a stable total order (`created_at`, then a unique `id`
 * tiebreaker), and the message batch chunks its `.in(ticketIds)` AND pages each
 * chunk. LOUD: a paged read binds the `error` and throws `readFailure` — a
 * partial set is never returned as fact (the product feature-signal reader keeps
 * its documented loud-DEGRADE-to-null contract instead, see its own doc).
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
  range: (from: number, to: number) => PromiseLike<{
    data: unknown[] | null;
    error: unknown;
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

/**
 * Read every row of a paged cross-tenant query, LOUD. `fetchAllRows` hands back
 * the partial set plus the error on a mid-page failure; we bind that error and
 * throw `readFailure` rather than aggregating over a silently-partial set (a
 * truncated ticket board presented as fact is the honesty defect this file
 * exists to avoid). The `.range(from, to)` builder must carry a stable total
 * order so no row shifts across a page boundary.
 */
async function pagedRows<T>(
  context: string,
  build: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(build);
  if (error) throw readFailure(context, error as SupabaseReadError);
  return data;
}

/** Chunk size for the `.in("ticket_id", …)` message batch — a chunk of this many
 * ticket ids is itself well below the 1000-row id-list limit, and each chunk's
 * MESSAGE result is then fully paged (a busy chunk can carry >1000 messages). */
const MSG_TICKET_CHUNK = 500;

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
  // 1. Pull every ticket joined with org name — PAGED (cross-tenant, mapped to
  //    the list UI + KPI tiles; a 1000-row clamp would drop tickets and
  //    under-count the tiles).
  const tickets = await pagedRows<{
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
  }>(
    "hq-support: tickets",
    (from, to) =>
      adminTable("support_tickets")
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
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to) as PromiseLike<PageResult<never>>,
  );

  if (tickets.length === 0) return [];

  // 2. Fetch all messages for these tickets so we can compute "last reply
  //    preview" + "has internal notes" per ticket without N+1. CHUNK the
  //    `.in("ticket_id", …)` id list (a chunk of ids stays below the id-list
  //    limit) AND fully PAGE each chunk's messages (a busy chunk can itself
  //    carry >1000 messages — the F-1 clamp would silently drop the older ones,
  //    corrupting both the preview and the internal-notes flag).
  const ticketIds = tickets.map((t) => t.id);
  const messages: Array<{
    id: string;
    ticket_id: string;
    body: string;
    internal: boolean;
    created_at: string;
  }> = [];
  for (let i = 0; i < ticketIds.length; i += MSG_TICKET_CHUNK) {
    const chunk = ticketIds.slice(i, i + MSG_TICKET_CHUNK);
    const batch = await pagedRows<{
      id: string;
      ticket_id: string;
      body: string;
      internal: boolean;
      created_at: string;
    }>(
      "hq-support: ticket messages",
      (from, to) =>
        adminTable("support_messages")
          .select("id, ticket_id, body, internal, created_at")
          .in("ticket_id", chunk)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to) as PromiseLike<PageResult<never>>,
    );
    messages.push(...batch);
  }

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
 * so it should not pull them cross-tenant. PAGED (fetchAllRows) — the board
 * counts these rows in JS, so a 1000-row clamp would silently under-report the
 * triage figures it labels "fact". LOUD: a read error throws `readFailure`
 * (never a silently-partial board).
 */
export async function listSupportTicketRowsForHq(): Promise<HqSupportBoardRow[]> {
  return pagedRows<HqSupportBoardRow>(
    "hq-support: board rows",
    (from, to) =>
      adminTable("support_tickets")
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
        // Stable total order: `created_at` desc + the unique `id` tiebreaker so
        // no row shifts across a page boundary (id need not be selected to be an
        // ORDER BY key — the board shape stays message-free).
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to) as PromiseLike<PageResult<HqSupportBoardRow>>,
  );
}

// ---------------------------------------------------------------------
// Product-signal reader — the leanest ticket shape, NO PII.
// ---------------------------------------------------------------------

/**
 * The minimal ticket columns the deterministic Product AI board needs:
 * id + category + status + created_at ONLY. No subject, no priority, no org
 * name, and crucially NO message bodies — the board groups by category and
 * counts feature-request/bug volume + request aging, none of which needs any
 * free-text field, so none is read (keeping customer PII off this surface).
 */
export type ProductSignalRow = {
  id: string;
  category: string;
  status: string;
  created_at: string;
};

/**
 * Fetch just the columns the Product AI board triages over. Unlike
 * `listSupportTicketRowsForHq` (priority/last-reply columns for the triage
 * board) and `listSupportTicketsForHq` (which additionally batch-fetches every
 * message body), this reads the barest ticket identity + category + status +
 * created_at. PAGED (fetchAllRows) — demand aggregation (feature-request / bug
 * volume + request aging) counts these rows in JS, so a 1000-row clamp would
 * silently under-report CEO demand. LOUD DEGRADE: on a read error we log and
 * return `null` (not `[]`, and not a partial set) so the pure layer marks demand
 * insufficient rather than fabricating a zero — its documented contract, which
 * `loadProductBoard` relies on (it maps `null` → demand insufficient).
 */
export async function listFeatureSignalRowsForHq(): Promise<
  ProductSignalRow[] | null
> {
  const { data, error } = await fetchAllRows<ProductSignalRow>(
    (from, to) =>
      adminTable("support_tickets")
        .select(["id", "category", "status", "created_at"].join(", "))
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to) as PromiseLike<PageResult<ProductSignalRow>>,
  );
  if (error) {
    console.error("[hq-product] feature-signal read failed", error);
    return null;
  }
  return data;
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

  // 3. Full message thread (INCLUDING internal — HQ sees everything). PAGED:
  //    a single long-lived ticket's thread is not provably below the 1000-row
  //    clamp, and the detail view + preview/internal-notes derivation need the
  //    WHOLE thread — a truncated tail would drop the newest replies. LOUD: a
  //    read error throws `readFailure` rather than rendering a partial thread.
  const messagesRaw = await pagedRows<{
    id: string;
    ticket_id: string;
    org_id: string;
    author_id: string | null;
    author_kind: "customer" | "hq";
    internal: boolean;
    body: string;
    created_at: string;
    author: { full_name?: string | null; email?: string | null } | null;
  }>(
    "hq-support: ticket thread",
    (from, to) =>
      adminTable("support_messages")
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
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<never>>,
  );
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

/**
 * Count open support tickets across every tenant (drives the HQ nav badge and
 * the CEO board's Support department).
 *
 * LOUD DEGRADE: on a read error we log and return `null` — NOT `0`. A swallowed
 * zero here is a fabricated-green honesty defect: the CEO board would render
 * Support as "All clear / Healthy" off an unreadable queue. `null` lets the
 * pure layer distinguish a CONFIRMED empty queue (query succeeded, 0 open) from
 * an UNREADABLE one (query failed) and mark the latter insufficient, matching
 * the loud-read discipline of its sibling `listFeatureSignalRowsForHq`.
 */
export async function countOpenSupportTicketsForHq(): Promise<number | null> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("support_tickets" as never)
    .select("id" as never, { count: "exact", head: true })
    .in("status" as never, ["open", "in_progress", "waiting_on_customer"]);
  if (error) {
    console.error("[hq-support] countOpenSupportTicketsForHq failed", error);
    return null;
  }
  return count ?? 0;
}
