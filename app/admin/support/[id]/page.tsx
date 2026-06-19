import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSupportTicketDetailForHq } from "@/server/services/hq-support-snapshot";
import { listAdminActivity } from "@/server/services/hq-audit";
import {
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABEL,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABEL,
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
import {
  Alert,
  Badge,
  Button,
  GlowHeader,
  Panel,
  Select,
  Surface,
  type Accent,
} from "@/components/ui";

type SP = Promise<{ saved?: string; error?: string }>;
type Params = Promise<{ id: string }>;

export const dynamic = "force-dynamic";

/** Dark-surface accent for each ticket status pill. */
const STATUS_ACCENT: Record<SupportStatus, Accent> = {
  open: "amber",
  in_progress: "sky",
  waiting_on_customer: "indigo",
  resolved: "emerald",
  closed: "slate",
};

/** Dark-surface accent for each ticket priority pill. */
const PRIORITY_ACCENT: Record<SupportPriority, Accent> = {
  low: "slate",
  normal: "sky",
  high: "amber",
  urgent: "rose",
};

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
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ · Support"
        title={ticket.subject}
        subtitle={
          <span className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-medium text-slate-300">
              #{ticket.ticket_number}
            </span>
            <span className="font-medium text-slate-300">
              {ticket.org_name ?? ticket.org_id.slice(0, 8)}
            </span>
            <Badge accent={STATUS_ACCENT[ticket.status as SupportStatus]}>
              {SUPPORT_STATUS_LABEL[ticket.status as SupportStatus] ?? ticket.status}
            </Badge>
            <Badge accent={PRIORITY_ACCENT[ticket.priority as SupportPriority]}>
              {SUPPORT_PRIORITY_LABEL[ticket.priority as SupportPriority] ?? ticket.priority}
            </Badge>
            <span className="text-slate-500">
              {SUPPORT_CATEGORY_LABEL[ticket.category as SupportCategory] ?? ticket.category}
            </span>
            <span className="text-slate-500">
              · Created {ticket.created_at.slice(0, 10)}
            </span>
          </span>
        }
        actions={
          <>
            <Link
              href="/admin/support"
              className="text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              ← Back to queue
            </Link>
            <Link
              href={`/admin/customers/${ticket.org_id}`}
              className="text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200"
            >
              Open customer →
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {banner ? (
          <Alert tone={banner.tone === "ok" ? "success" : "danger"}>
            {banner.msg}
          </Alert>
        ) : null}

        <div className="grid gap-5 md:grid-cols-3">
          {/* Thread + reply (2/3) */}
          <section className="space-y-3 md:col-span-2">
            {ticket.messages.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-4 py-6 text-center text-sm text-slate-500">
                No messages yet.
              </p>
            ) : (
              ticket.messages.map((m) => (
                <article
                  key={m.id}
                  className={`rounded-xl border p-4 ${
                    m.internal
                      ? "border-amber-500/30 bg-amber-500/10"
                      : m.author_kind === "hq"
                        ? "border-indigo-500/30 bg-indigo-500/10"
                        : "border-slate-800 bg-slate-900/60"
                  }`}
                >
                  <header className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-slate-200">
                      {m.author_kind === "hq" ? "🛡 " : ""}
                      {m.author_name ?? (m.author_kind === "hq" ? "CrewFlow HQ" : "Customer")}
                      {m.internal ? (
                        <span className="ml-2 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-400/30">
                          Internal note
                        </span>
                      ) : null}
                    </span>
                    <span className="text-slate-500">
                      {m.created_at.slice(0, 16).replace("T", " ")} UTC
                    </span>
                  </header>
                  <p className="whitespace-pre-wrap text-sm text-slate-100">
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
            <Panel title="Status">
              <form action={setTicketStatus} className="flex items-center gap-2">
                <input type="hidden" name="ticket_id" value={ticket.id} />
                <Select name="status" defaultValue={ticket.status}>
                  {SUPPORT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {SUPPORT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="accent" size="sm">
                  Set
                </Button>
              </form>
            </Panel>

            <Panel title="Priority">
              <form action={setTicketPriority} className="flex items-center gap-2">
                <input type="hidden" name="ticket_id" value={ticket.id} />
                <Select name="priority" defaultValue={ticket.priority}>
                  {SUPPORT_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {SUPPORT_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="accent" size="sm">
                  Set
                </Button>
              </form>
            </Panel>

            <Panel title="Category">
              <form action={setTicketCategory} className="flex items-center gap-2">
                <input type="hidden" name="ticket_id" value={ticket.id} />
                <Select name="category" defaultValue={ticket.category}>
                  {SUPPORT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {SUPPORT_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </Select>
                <Button type="submit" variant="accent" size="sm">
                  Set
                </Button>
              </form>
            </Panel>

            <Panel title="Customer">
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Org</dt>
                  <dd className="font-medium text-white">
                    {ticket.org_name ?? "(unnamed)"}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Status</dt>
                  <dd className="text-slate-300">{ticket.org_status ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Owner</dt>
                  <dd className="text-slate-300">{ticket.owner_name ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Owner email</dt>
                  <dd className="text-slate-300">
                    {ticket.owner_email ? (
                      <a
                        href={`mailto:${ticket.owner_email}`}
                        className="text-indigo-300 transition-colors hover:text-indigo-200"
                      >
                        {ticket.owner_email}
                      </a>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
            </Panel>

            <Panel title="Activity">
              {timeline.length === 0 ? (
                <p className="text-xs text-slate-500">No actions yet.</p>
              ) : (
                <ul className="space-y-1 text-[11px] text-slate-400">
                  {timeline.map((row) => (
                    <li key={row.id} className="flex justify-between gap-2">
                      <span>{row.action}</span>
                      <span className="text-slate-500">
                        {row.created_at.slice(0, 16).replace("T", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </aside>
        </div>
      </div>
    </Surface>
  );
}
