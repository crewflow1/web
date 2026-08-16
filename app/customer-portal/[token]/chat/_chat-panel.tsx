"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sendPortalChatMessage } from "./_chat-action";
import type { PortalChatMessage } from "./_chat-reads";

/**
 * MP Phase 8 "Live Chat" — the customer's chat panel (client).
 *
 * Two jobs:
 *   1. SEND — a plain server-action form (sendPortalChatMessage). No
 *      useActionState: the action redirects back to this tab, which is the
 *      safe pattern on the portal's dynamic routes and resets the composer for
 *      free. The customer's message + the automated acknowledgement are on the
 *      page when it re-renders.
 *   2. TAIL STAFF REPLIES — HONEST NEAR-REAL-TIME POLLING. This is NOT a
 *      websocket and NOT a push stream: every POLL_INTERVAL_MS the panel GETs
 *      ./poll?after=<lastSeen> and appends any newer messages. Between polls the
 *      panel is simply stale — the delay is the cost of not running a socket,
 *      and it is deliberate and disclosed here.
 *
 * Accessible + mobile-first: the thread is an aria-live log, the composer has a
 * real <label>, controls are ≥44px, and muted text stays at slate-600 (never
 * slate-400 on white) for WCAG AA contrast.
 */

/** Poll cadence. ~4s balances freshness against request volume on a per-customer
 *  token budget. Honest polling — not realtime. */
const POLL_INTERVAL_MS = 4000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({
  token,
  orgName,
  initialMessages,
}: {
  token: string;
  orgName: string;
  initialMessages: PortalChatMessage[];
}) {
  const [messages, setMessages] = useState<PortalChatMessage[]>(initialMessages);
  const seenIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)));
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const lastSeenCreatedAt = messages.length
    ? messages[messages.length - 1]!.created_at
    : null;

  // Poll for messages newer than the newest one we already hold, and append the
  // ones we haven't seen. Deduped by id so an overlapping cursor can't double up.
  const poll = useCallback(async () => {
    try {
      const qs = lastSeenCreatedAt
        ? `?after=${encodeURIComponent(lastSeenCreatedAt)}`
        : "";
      const res = await fetch(`/customer-portal/${token}/chat/poll${qs}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: PortalChatMessage[] };
      const incoming = data.messages ?? [];
      const fresh = incoming.filter((m) => !seenIds.current.has(m.id));
      if (fresh.length === 0) return;
      for (const m of fresh) seenIds.current.add(m.id);
      setMessages((prev) => [...prev, ...fresh]);
    } catch {
      // A dropped poll is harmless — the next tick retries.
    }
  }, [token, lastSeenCreatedAt]);

  useEffect(() => {
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
      <div
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        className="flex max-h-[60vh] min-h-[240px] flex-col gap-3 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <p className="m-auto max-w-sm text-center text-sm text-slate-600">
            No messages yet. Send a message and {orgName} will reply here.
          </p>
        ) : (
          messages.map((m) => {
            const isCustomer = m.direction === "inbound";
            const who = isCustomer
              ? "You"
              : m.auto_generated
                ? "Automated"
                : orgName;
            return (
              <div
                key={m.id}
                className={`flex flex-col ${isCustomer ? "items-end" : "items-start"}`}
              >
                <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[11px] text-slate-600">
                  <span className="font-medium">{who}</span>
                  {!isCustomer && m.auto_generated ? (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                      automated
                    </span>
                  ) : null}
                  <span aria-hidden="true">·</span>
                  <time dateTime={m.created_at}>{formatTime(m.created_at)}</time>
                </div>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                    isCustomer
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-slate-50 text-slate-900"
                  }`}
                >
                  {m.body}
                </div>
              </div>
            );
          })
        )}
        <div ref={listEndRef} />
      </div>

      <form
        action={sendPortalChatMessage}
        className="flex items-end gap-2 border-t border-slate-200 p-3"
      >
        <input type="hidden" name="token" value={token} />
        <label className="flex-1 text-sm">
          <span className="sr-only">Your message</span>
          <textarea
            name="body"
            required
            minLength={1}
            maxLength={10_000}
            rows={2}
            placeholder="Type your message…"
            className="block w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
        <button
          type="submit"
          className="min-h-[44px] shrink-0 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-1"
        >
          Send
        </button>
      </form>
    </div>
  );
}
