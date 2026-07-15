import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { sendPortalMessage } from "../../_message-action";

/**
 * Customer portal — Messages.
 *
 * Lists every conversation the customer has had with this org and
 * lets them start a new message. Each message thread is a
 * `support_tickets` row + `support_messages` rows the existing
 * /admin/support and tenant /support pages already render.
 *
 * Phase 3 directive step 6 — messaging from portal.
 */

type SP = Promise<{ saved?: string; error?: string }>;

export default async function PortalMessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();

  // SECURITY: scope strictly to THIS customer. The portal runs under the
  // service-role admin client (no Supabase JWT, so RLS cannot scope it), so we
  // MUST filter by customer_id explicitly — filtering by org_id alone exposed
  // every other customer's tickets in the org (cross-customer leak, fixed here).
  // support_tickets.customer_id is added by migration
  // 20260706000000_support_tickets_customer_scope.sql and stamped on write by
  // sendPortalMessage(). Tickets predating that column (customer_id IS NULL)
  // intentionally do not appear in the portal.
  type TicketQuery = {
    eq: (k: string, v: unknown) => TicketQuery;
    order: (
      k: string,
      opts: { ascending: boolean },
    ) => {
      limit: (n: number) => Promise<{
        data: unknown[] | null;
        error: { message: string } | null;
      }>;
    };
  };
  const { data: ticketsRaw } = await (
    admin.from("support_tickets" as never) as unknown as {
      select: (cols: string) => TicketQuery;
    }
  )
    .select(
      `
        id, ticket_number, subject, status, priority, category,
        last_reply_at, created_at,
        last_message:support_messages!support_messages_ticket_id_fkey ( body, created_at, author_kind, internal )
      `,
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(20);
  type TicketRow = {
    id: string;
    ticket_number: number;
    subject: string;
    status: string;
    priority: string;
    category: string;
    last_reply_at: string | null;
    created_at: string;
    last_message?: Array<{
      body: string;
      created_at: string;
      author_kind: string;
      internal: boolean;
    }>;
  };
  // Already scoped to this customer at the query level (org_id + customer_id);
  // internal HQ notes are excluded from the preview below (see lastVisible).
  const tickets = (ticketsRaw ?? []) as unknown as TicketRow[];

  const banner = (() => {
    if (sp.saved === "sent")
      return {
        tone: "ok" as const,
        msg: "Message sent. We'll get back to you shortly.",
      };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="messages">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Messages</h2>
        <p className="text-sm text-slate-600">
          Send {org.name} a question, or follow up on an existing thread.
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

      {/* New message form */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">New message</h3>
        <form
          action={sendPortalMessage}
          className="mt-3 space-y-3"
        >
          <input type="hidden" name="token" value={token} />
          <input
            name="subject"
            type="text"
            required
            minLength={3}
            maxLength={200}
            placeholder="Subject (e.g. Question about quote Q-1042)"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <textarea
            name="body"
            required
            minLength={1}
            maxLength={10_000}
            rows={5}
            placeholder="What would you like to ask?"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Send message
          </button>
        </form>
      </section>

      {/* Existing threads */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">
          Recent conversations
        </h3>
        {tickets.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No messages yet. Send your first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {tickets.map((t) => {
              // Last visible message for the preview line: non-internal, and
              // one of the two parties to this conversation. 'hq' is CrewFlow
              // talking to the org on its own helpdesk — not addressed to this
              // customer, and previously previewed as though the org sent it.
              const lastVisible = (t.last_message ?? []).find(
                (m) => !m.internal && m.author_kind !== "hq",
              );
              return (
                <li key={t.id}>
                  <a
                    href={`/customer-portal/${token}/messages/${t.id}`}
                    className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        #{t.ticket_number} · {t.subject}
                      </p>
                      <span className="shrink-0 text-[11px] text-slate-500">
                        {t.status}
                      </span>
                    </div>
                    {lastVisible ? (
                      <p className="mt-1 line-clamp-2 text-xs text-slate-600">
                        <span className="font-medium">
                          {lastVisible.author_kind === "customer"
                            ? "You: "
                            : `${org.name}: `}
                        </span>
                        {lastVisible.body}
                      </p>
                    ) : null}
                    <p className="mt-2 text-[11px] font-medium text-slate-400">
                      View conversation →
                    </p>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
