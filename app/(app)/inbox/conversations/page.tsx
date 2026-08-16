import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listInboxConversations } from "@/server/services/inbox-conversations";
import { INBOX_CHANNEL_LABELS, type InboxChannel } from "@/lib/inbox/channels";
import { contactLabel, type ConversationSummary } from "@/lib/inbox/thread";
import { EmptyState } from "../../_components/empty-state";
import { InboxTabs } from "../_components/inbox-tabs";

/**
 * /inbox/conversations — the UNIFIED communications inbox.
 *
 * One two-way thread per customer per channel (email / sms / whatsapp / voice / chat),
 * newest activity first, with a last-message preview and an "awaiting reply" flag when the
 * customer spoke last. Reply happens inside the thread; a new outbound conversation starts
 * from here. Distinct from the one-way enquiry list at /inbox.
 */

export const dynamic = "force-dynamic";

const CHANNEL_PILL: Record<InboxChannel, string> = {
  email: "bg-sky-100 text-sky-800",
  sms: "bg-emerald-100 text-emerald-800",
  whatsapp: "bg-green-100 text-green-800",
  voice: "bg-violet-100 text-violet-800",
  chat: "bg-slate-100 text-slate-700",
};

const ERROR_MAP: Record<string, string> = {
  invalid_input: "That didn't look right. Check the fields and try again.",
  not_found: "That conversation could not be found.",
  reply_failed: "Couldn't record the reply. Try again.",
  create_failed: "Couldn't start the conversation. Try again.",
  status_failed: "Couldn't update the conversation. Try again.",
};

type SP = Promise<{ view?: string; error?: string }>;

export default async function ConversationsPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  const view = sp.view === "archived" ? "archived" : sp.view === "all" ? "all" : "active";
  const all = await listInboxConversations(ctx.org.id);
  const rows =
    view === "all" ? all : all.filter((c) => c.status === (view === "archived" ? "archived" : "active"));

  const awaiting = all.filter((c) => c.status === "active" && c.awaitingReply).length;
  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? "Something went wrong." : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <InboxTabs active="conversations" />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Conversations</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every two-way conversation with your customers — email, SMS, WhatsApp, voice and
            chat — in one thread. Reply from here.
            {awaiting > 0 ? (
              <span className="ml-1 font-medium text-slate-900">
                {awaiting} awaiting your reply.
              </span>
            ) : null}
          </p>
        </div>
        <Link
          href="/inbox/conversations/new"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          New message
        </Link>
      </header>

      <nav aria-label="View" className="flex flex-wrap gap-2 text-xs">
        <ViewLink current={view} value="active" label="Active" />
        <ViewLink current={view} value="archived" label="Archived" />
        <ViewLink current={view} value="all" label="All" />
      </nav>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="💬"
            title="No conversations yet"
            body="When a customer emails, texts or messages you, their conversation appears here — or start one yourself."
            primary={{ href: "/inbox/conversations/new", label: "New message" }}
            secondary={{ href: "/inbox", label: "View enquiries" }}
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/inbox/conversations/${row.id}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
              >
                <ConversationRow row={row} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationRow({ row }: { row: ConversationSummary }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${CHANNEL_PILL[row.channel] ?? "bg-slate-100 text-slate-700"}`}
          >
            {INBOX_CHANNEL_LABELS[row.channel] ?? row.channel}
          </span>
          {row.awaitingReply ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              Awaiting reply
            </span>
          ) : null}
          {row.status === "archived" ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-500">
              Archived
            </span>
          ) : null}
          <span className="text-slate-500">{formatWhen(row.last_message_at)}</span>
        </div>
        <p className="mt-1.5 truncate text-sm font-medium text-slate-900">
          {contactLabel(row)}
        </p>
        {row.lastPreview ? (
          <p className="mt-0.5 truncate text-sm text-slate-600">
            {row.lastDirection === "outbound" ? "You: " : ""}
            {row.lastPreview}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ViewLink({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const isActive = current === value;
  const href = value === "active" ? "/inbox/conversations" : `/inbox/conversations?view=${value}`;
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-full bg-slate-900 px-3 py-1 font-medium text-white"
          : "rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {label}
    </Link>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
    });
  } catch {
    return iso;
  }
}
