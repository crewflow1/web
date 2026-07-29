import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMySupportTicket } from "@/server/services/customer-support-service";
import {
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_PILL,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_PRIORITY_PILL,
  SUPPORT_CATEGORY_LABEL,
  type SupportStatus,
  type SupportPriority,
  type SupportCategory,
} from "@/lib/hq/support";
import { replyToSupportTicket } from "../actions";

type SP = Promise<{ saved?: string; error?: string }>;
type Params = Promise<{ id: string }>;

export const dynamic = "force-dynamic";

export default async function CustomerSupportTicketPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ticket = await loadMySupportTicket(id);
  if (!ticket) notFound();

  const banner = (() => {
    if (sp.saved === "reply")
      return { tone: "ok" as const, msg: "Reply sent." };
    if (sp.error === "reply_failed")
      return { tone: "err" as const, msg: "Reply failed — try again." };
    return null;
  })();

  const isClosed = ticket.status === "closed" || ticket.status === "resolved";

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header>
        <Link
          href="/support"
          className="text-[11px] font-medium text-slate-500 hover:underline"
        >
          ← All tickets
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold text-slate-900">
            <span className="text-slate-600">#{ticket.ticket_number}</span>{" "}
            {ticket.subject}
          </h1>
          <span className="text-[11px] text-slate-500">
            Created {ticket.created_at.slice(0, 10)}
          </span>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_STATUS_PILL[ticket.status as SupportStatus]}`}
          >
            {SUPPORT_STATUS_LABEL[ticket.status as SupportStatus] ?? ticket.status}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SUPPORT_PRIORITY_PILL[ticket.priority as SupportPriority]}`}
          >
            {SUPPORT_PRIORITY_LABEL[ticket.priority as SupportPriority] ?? ticket.priority}
          </span>
          <span className="text-slate-500">
            {SUPPORT_CATEGORY_LABEL[ticket.category as SupportCategory] ?? ticket.category}
          </span>
        </p>
      </header>

      {banner ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.msg}
        </div>
      ) : null}

      {/* Thread */}
      <section className="space-y-3">
        {ticket.messages.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No replies yet.
          </p>
        ) : (
          ticket.messages.map((m) => {
            const isHq = m.author_kind === "hq";
            // On a portal thread, 'customer' is the END-CUSTOMER, not this org.
            // The service names them from the ticket's customer; falling back to
            // "You" here would put the homeowner's words in the org's mouth.
            const isTheirCustomer =
              m.author_kind === "customer" && ticket.customer_id != null;
            return (
              <article
                key={m.id}
                className={`rounded-xl border p-4 shadow-sm ${
                  isHq
                    ? "border-indigo-200 bg-indigo-50"
                    : isTheirCustomer
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-slate-200 bg-white"
                }`}
              >
                <header className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-slate-700">
                    {m.author_name ??
                      (isHq
                        ? "CrewFlow Support"
                        : isTheirCustomer
                          ? "Customer"
                          : "You")}
                  </span>
                  <span className="text-slate-500">
                    {m.created_at.slice(0, 16).replace("T", " ")} UTC
                  </span>
                </header>
                <p className="whitespace-pre-wrap text-sm text-slate-900">
                  {m.body}
                </p>
              </article>
            );
          })
        )}
      </section>

      {/* Reply box */}
      {isClosed ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-center text-xs text-slate-500">
          This ticket is {ticket.status}. Open a new ticket if you need
          further help.
        </p>
      ) : (
        <form
          action={replyToSupportTicket}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <input type="hidden" name="ticket_id" value={ticket.id} />
          <label className="block text-sm font-medium text-slate-700">
            Reply
            <textarea
              name="body"
              required
              minLength={1}
              maxLength={10_000}
              rows={4}
              placeholder="Type your reply…"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Send reply
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
