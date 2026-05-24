import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSupportTicketDetailForHq } from "@/server/services/hq-support-snapshot";
import { listAdminActivity } from "@/server/services/hq-audit";
import {
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABEL,
  SUPPORT_STATUS_PILL,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABEL,
  SUPPORT_PRIORITY_PILL,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABEL,
  type SupportStatus,
  type SupportPriority,
  type SupportCategory,
} from "@/lib/hq/support";
import {
  replyAsHq,
  setTicketStatus,
  setTicketPriority,
  setTicketCategory,
} from "../actions";
import { SupportReplyForm } from "./_reply-form";

type SP = Promise<{ saved?: string; error?: string }>;
type Params = Promise<{ id: string }>;

export const dynamic = "force-dynamic";

export default async function HqSupportTicketDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const ticket = await loadSupportTicketDetailForHq(id);
  if (!ticket) notFound();

  // Audit-log timeline (status changes, assigns) for this ticket.
  const timeline = await listAdminActivity("support_tickets", id, 25);

  const banner = (() => {
    if (sp.saved)
      return { tone: "ok" as const, msg: `Saved (${sp.saved}).` };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <header>
        <Link
          href="/admin/support"
          className="text-[11px] font-medium text-slate-500 hover:underline"
        >
          ← Back to queue
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold text-slate-900">
            <span className="text-slate-400">#{ticket.ticket_number}</span>{" "}
            {ticket.subject}
          </h1>
          <Link
            href={`/admin/customers/${ticket.org_id}`}
            className="text-[11px] font-medium text-indigo-700 hover:underline"
          >
            Open customer →
          </Link>
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-medium text-slate-700">
            {ticket.org_name ?? ticket.org_id.slice(0, 8)}
          </span>
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
          <span className="text-slate-500">
            · Created {ticket.created_at.slice(0, 10)}
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

      <div className="grid gap-5 md:grid-cols-3">
        {/* Thread + reply (2/3) */}
        <section className="space-y-3 md:col-span-2">
          {ticket.messages.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
              No messages yet.
            </p>
          ) : (
            ticket.messages.map((m) => (
              <article
                key={m.id}
                className={`rounded-xl border p-4 shadow-sm ${
                  m.internal
                    ? "border-amber-300 bg-amber-50"
                    : m.author_kind === "hq"
                      ? "border-indigo-200 bg-indigo-50"
                      : "border-slate-200 bg-white"
                }`}
              >
                <header className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-slate-700">
                    {m.author_kind === "hq" ? "🛡 " : ""}
                    {m.author_name ?? (m.author_kind === "hq" ? "CrewFlow HQ" : "Customer")}
                    {m.internal ? (
                      <span className="ml-2 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                        Internal note
                      </span>
                    ) : null}
                  </span>
                  <span className="text-slate-500">
                    {m.created_at.slice(0, 16).replace("T", " ")} UTC
                  </span>
                </header>
                <p className="whitespace-pre-wrap text-sm text-slate-900">
                  {m.body}
                </p>
              </article>
            ))
          )}

          {/* Reply form — confirms before sending customer-visible replies */}
          <SupportReplyForm
            action={replyAsHq}
            ticketId={ticket.id}
            customerEmail={ticket.owner_email ?? ticket.org_email ?? null}
          />

        </section>

        {/* Side panel: ticket controls + customer info (1/3) */}
        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Status
            </h3>
            <form action={setTicketStatus} className="mt-2 flex items-center gap-2">
              <input type="hidden" name="ticket_id" value={ticket.id} />
              <select
                name="status"
                defaultValue={ticket.status}
                className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {SUPPORT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {SUPPORT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Set
              </button>
            </form>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Priority
            </h3>
            <form action={setTicketPriority} className="mt-2 flex items-center gap-2">
              <input type="hidden" name="ticket_id" value={ticket.id} />
              <select
                name="priority"
                defaultValue={ticket.priority}
                className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {SUPPORT_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {SUPPORT_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Set
              </button>
            </form>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Category
            </h3>
            <form action={setTicketCategory} className="mt-2 flex items-center gap-2">
              <input type="hidden" name="ticket_id" value={ticket.id} />
              <select
                name="category"
                defaultValue={ticket.category}
                className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {SUPPORT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SUPPORT_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Set
              </button>
            </form>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Customer
            </h3>
            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Org</dt>
                <dd className="font-medium text-slate-900">
                  {ticket.org_name ?? "(unnamed)"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Status</dt>
                <dd className="text-slate-700">{ticket.org_status ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Owner</dt>
                <dd className="text-slate-700">{ticket.owner_name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Owner email</dt>
                <dd className="text-slate-700">
                  {ticket.owner_email ? (
                    <a
                      href={`mailto:${ticket.owner_email}`}
                      className="hover:underline"
                    >
                      {ticket.owner_email}
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Activity
            </h3>
            {timeline.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No actions yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {timeline.map((row) => (
                  <li key={row.id} className="flex justify-between gap-2">
                    <span>{row.action}</span>
                    <span className="text-slate-400">
                      {row.created_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
