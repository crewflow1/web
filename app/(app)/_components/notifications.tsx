"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { markNotificationsRead, markOneNotificationRead } from "./notifications-actions";

/**
 * Bell-icon dropdown — opens to show the most-recent 15 notifications.
 * Unread count is a small red badge. Clicking the bell marks the list
 * read (so the badge clears) but keeps each row visible until it ages
 * out — same pattern as Slack / Linear.
 *
 * Client component because the dropdown needs open/close state +
 * click-outside detection. Initial server-rendered list arrives via
 * `initial` so we paint the badge with no extra round-trip.
 */

export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  action_url: string | null;
  read_at: string | null;
  created_at: string;
};

export function NotificationsBell({ initial }: { initial: Notification[] }) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const unread = initial.filter((n) => !n.read_at).length;

  function toggleOpen() {
    if (!open && unread > 0) {
      startTransition(() => {
        markNotificationsRead();
      });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Notifications"
        className="relative rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span>Notifications</span>
            <Link
              href="/activity"
              className="font-medium text-slate-700 hover:text-slate-900"
              onClick={() => setOpen(false)}
            >
              activity log →
            </Link>
          </div>
          {initial.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              You&apos;re all caught up.
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {initial.slice(0, 15).map((n) => (
                <NotificationRow key={n.id} n={n} close={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({ n, close }: { n: Notification; close: () => void }) {
  const body = (
    <div className={n.read_at ? "opacity-70" : ""}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-xs">{n.read_at ? "" : "•"}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900">{n.title}</div>
          {n.body ? (
            <div className="mt-0.5 truncate text-xs text-slate-500">{n.body}</div>
          ) : null}
          <div className="mt-0.5 text-[11px] text-slate-500">
            {relativeTime(n.created_at)}
          </div>
        </div>
      </div>
    </div>
  );
  if (n.action_url) {
    return (
      <li>
        <Link
          href={n.action_url}
          className="block px-3 py-2 hover:bg-slate-50"
          onClick={() => {
            close();
            // also mark this one read explicitly (idempotent)
            markOneNotificationRead(n.id);
          }}
        >
          {body}
        </Link>
      </li>
    );
  }
  return <li className="px-3 py-2">{body}</li>;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
