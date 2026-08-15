import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { loadInboxThread } from "@/server/services/inbox-conversations";
import {
  canSendOnChannel,
  INBOX_CHANNEL_LABELS,
  type InboxChannel,
} from "@/lib/inbox/channels";
import { contactLabel, type InboxMessage } from "@/lib/inbox/thread";
import { replyToConversation, setConversationStatus } from "../actions";

/**
 * /inbox/conversations/[id] — one conversation thread + the reply composer.
 *
 * The composer rides the dark-safe send: on a channel with no configured provider (the
 * default today) the reply is QUEUED — recorded and shown as "Queued · provider not
 * configured", never lost, never crashing. voice/chat have no outbound transport at all,
 * so a reply there always queues; the composer says so up front.
 */

export const dynamic = "force-dynamic";

const SENT_NOTE: Record<string, { tone: "ok" | "warn"; text: string }> = {
  sent: { tone: "ok", text: "Reply sent." },
  queued: {
    tone: "warn",
    text: "Reply queued — this channel's provider isn't configured yet, so nothing was sent. It's recorded and will go out once a provider is connected.",
  },
  failed: { tone: "warn", text: "Reply recorded but could not be delivered." },
};

const STATUS_PILL: Record<string, string> = {
  received: "bg-slate-100 text-slate-600",
  sent: "bg-emerald-100 text-emerald-800",
  queued: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  delivered: "bg-emerald-100 text-emerald-800",
};

type Params = Promise<{ id: string }>;
type SP = Promise<{ sent?: string; error?: string }>;

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const thread = await loadInboxThread(ctx.org.id, id);
  if (!thread) notFound();

  const { conversation, messages } = thread;
  const channel = conversation.channel as InboxChannel;
  const sendable = canSendOnChannel(channel);
  const note = sp.sent ? SENT_NOTE[sp.sent] ?? null : null;
  const isArchived = conversation.status === "archived";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/inbox/conversations" className="text-sm text-slate-500 hover:text-slate-800">
          ← All conversations
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-slate-900">{contactLabel(conversation)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
              {INBOX_CHANNEL_LABELS[channel] ?? channel}
            </span>
            {conversation.subject ? <span>· {conversation.subject}</span> : null}
            {isArchived ? <span className="text-slate-400">· Archived</span> : null}
          </div>
        </div>
        <form action={setConversationStatus}>
          <input type="hidden" name="conversation_id" value={conversation.id} />
          <input type="hidden" name="status" value={isArchived ? "active" : "archived"} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {isArchived ? "Reactivate" : "Archive"}
          </button>
        </form>
      </header>

      {note ? (
        <div
          role="status"
          className={
            note.tone === "ok"
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          }
        >
          {note.text}
        </div>
      ) : null}
      {sp.error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Couldn't complete that action. Try again.
        </div>
      ) : null}

      <section className="space-y-3">
        {messages.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No messages yet.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {!sendable ? (
          <p className="mb-2 text-xs text-amber-700">
            {INBOX_CHANNEL_LABELS[channel]} has no outbound sender — a reply will be queued (recorded, not sent).
          </p>
        ) : null}
        <form action={replyToConversation} className="space-y-3">
          <input type="hidden" name="conversation_id" value={conversation.id} />
          <label htmlFor="body" className="sr-only">
            Your reply
          </label>
          <textarea
            id="body"
            name="body"
            required
            minLength={1}
            maxLength={10_000}
            rows={4}
            placeholder="Write a reply…"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Send reply
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const isOutbound = message.direction === "outbound";
  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-xl border px-3 py-2 text-sm shadow-sm ${
          isOutbound ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-800"
        }`}
      >
        <p className="whitespace-pre-wrap">{message.body}</p>
        <div
          className={`mt-1 flex items-center gap-2 text-[11px] ${isOutbound ? "text-slate-300" : "text-slate-400"}`}
        >
          <span>{formatWhen(message.created_at)}</span>
          {isOutbound && message.status ? (
            <span className={`rounded-full px-1.5 py-0.5 font-medium ${STATUS_PILL[message.status] ?? "bg-slate-100 text-slate-600"}`}>
              {message.status === "queued" && message.failure_reason === "provider_not_configured"
                ? "Queued · no provider"
                : message.status}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
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
