import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../../_helpers";
import { PortalShell } from "../../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { replyToPortalThread } from "../../../_thread-reply-action";

/**
 * Customer portal — one support thread (view + reply).
 *
 * Completes the messaging workflow: the list page (../page.tsx) can only OPEN
 * a new thread; this reads a single ticket's full conversation and lets the
 * customer reply in-thread via `replyToPortalThread`.
 *
 * SECURITY: service-role read (the portal has no JWT, so RLS can't scope it).
 * The ticket is loaded scoped by org_id + customer_id + id, so a crafted
 * ticketId for another customer/org fails closed to InvalidLinkPage. Because
 * the admin client BYPASSES the `internal = false` RLS policy that protects
 * tenant SELECTs, we filter internal messages out EXPLICITLY here — an HQ
 * operator's private notes must never reach the customer.
 */

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_customer: "Awaiting your reply",
  resolved: "Resolved",
  closed: "Closed",
};

const STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-800",
  waiting_on_customer: "bg-indigo-100 text-indigo-800",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-slate-100 text-slate-600",
};

type SP = Promise<{ saved?: string; error?: string }>;

export default async function PortalThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; ticketId: string }>;
  searchParams: SP;
}) {
  const { token, ticketId } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();

  // Scope the ticket to THIS customer. org_id + customer_id + id is the only
  // thing stopping another customer's thread from loading via a crafted id.
  type TicketLookup = {
    eq: (k: string, v: unknown) => TicketLookup;
    maybeSingle: () => Promise<{
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    }>;
  };
  const { data: ticketRaw } = await (
    admin.from("support_tickets" as never) as unknown as {
      select: (cols: string) => TicketLookup;
    }
  )
    .select("id, ticket_number, subject, status, created_at")
    .eq("id", ticketId)
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!ticketRaw) return <InvalidLinkPage kind="portal" />;
  const ticket = ticketRaw as unknown as {
    id: string;
    ticket_number: number;
    subject: string;
    status: string;
    created_at: string;
  };

  // Messages for the thread. The admin client bypasses the internal=false RLS
  // policy, so we filter internal messages out EXPLICITLY (both at the query
  // and again in JS) — HQ private notes must never reach the customer.
  type MsgQuery = {
    eq: (k: string, v: unknown) => MsgQuery;
    in: (k: string, v: unknown[]) => MsgQuery;
    order: (
      k: string,
      opts: { ascending: boolean },
    ) => Promise<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>;
  };
  const { data: msgsRaw } = await (
    admin.from("support_messages" as never) as unknown as {
      select: (cols: string) => MsgQuery;
    }
  )
    .select("id, body, author_kind, internal, created_at")
    .eq("ticket_id", ticket.id)
    .eq("org_id", customer.org_id)
    .eq("internal", false)
    // Only the two parties to THIS conversation. 'hq' is CrewFlow talking to
    // the org on its own helpdesk — never addressed to the customer, and
    // previously rendered to them as though the org had written it.
    .in("author_kind", ["customer", "org"])
    .order("created_at", { ascending: true });
  type MsgRow = {
    id: string;
    body: string;
    author_kind: string;
    internal: boolean;
    created_at: string;
  };
  // Belt-and-braces on both narrowing filters above: the admin client bypasses
  // RLS, so nothing else stops an internal HQ note — or an 'hq' message that
  // isn't part of this conversation — reaching the customer.
  const messages = ((msgsRaw ?? []) as unknown as MsgRow[]).filter(
    (m) => !m.internal && m.author_kind !== "hq",
  );

  const banner = (() => {
    if (sp.saved === "reply")
      return {
        tone: "ok" as const,
        msg: "Reply sent. We'll get back to you shortly.",
      };
    if (sp.error) return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  // The after-insert trigger only re-opens a `waiting_on_customer` ticket on a
  // customer reply — resolved/closed stay put. So a reply to a terminal ticket
  // would silently go nowhere; hide the form there and point the customer at a
  // fresh thread instead (graceful degradation that respects the DB's state).
  const isClosed = ticket.status === "closed" || ticket.status === "resolved";

  return (
    <PortalShell customer={customer} org={org} token={token} active="messages">
      <div>
        <a
          href={`/customer-portal/${token}/messages`}
          className="text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          ← Back to messages
        </a>
      </div>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-slate-900">
            #{ticket.ticket_number} · {ticket.subject}
          </h2>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[ticket.status] ?? "bg-slate-100 text-slate-600"}`}
          >
            {STATUS_LABELS[ticket.status] ?? ticket.status}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Opened {ticket.created_at.slice(0, 10)}
        </p>
      </header>

      {banner ? (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${banner.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
        >
          {banner.msg}
        </div>
      ) : null}

      {/* Conversation */}
      <section className="space-y-3">
        {messages.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No messages on this thread yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {messages.map((m) => {
              // Attribute on the customer actor, NOT on "anything that isn't
              // CrewFlow". The old `!== "hq"` test made every org reply render
              // as the customer's own message, because the org's only available
              // actor was 'customer'.
              const mine = m.author_kind === "customer";
              return (
                <li
                  key={m.id}
                  className={`flex ${mine ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm shadow-sm ${mine ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-800"}`}
                  >
                    <p
                      className={`mb-0.5 text-[11px] font-medium ${mine ? "text-slate-300" : "text-slate-500"}`}
                    >
                      {mine ? "You" : org.name} ·{" "}
                      {m.created_at.slice(0, 10)}
                    </p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Reply */}
      {isClosed ? (
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
          <p className="text-sm font-medium text-slate-700">
            This conversation is {STATUS_LABELS[ticket.status]?.toLowerCase()}.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Need something else?{" "}
            <a
              href={`/customer-portal/${token}/messages`}
              className="font-medium text-slate-700 underline hover:text-slate-900"
            >
              Start a new message
            </a>
            .
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900">Reply</h3>
          <form action={replyToPortalThread} className="mt-3 space-y-3">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="ticket_id" value={ticket.id} />
            <textarea
              name="body"
              required
              minLength={1}
              maxLength={10_000}
              rows={4}
              placeholder={`Reply to ${org.name}…`}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Send reply
            </button>
          </form>
        </section>
      )}
    </PortalShell>
  );
}
